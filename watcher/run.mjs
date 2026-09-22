/**
 * The watcher as a service: every `INTERVAL_MS`, for every sale, attest (credit or return what
 * arrived) and crank (launch or fail when settled, then deliver).
 *
 *   SOLANA_RPC_URL=… ATTESTER_KEY=keys/attester-mainnet.json LAUNCH_LUT=<table> node watcher/run.mjs
 *
 * ⛔ ATTESTER_KEY must be the key compiled into the program as `ATTESTER`. It needs SOL: each
 * credit pays a position's rent the first time (~0.0016) plus a receipt (~0.0009), each return a
 * receipt, and each delivery may create a buyer's token account (~0.002).
 * ⚠ Reads at `finalized` by default, so a transfer is only decided once it cannot be rolled back.
 */
import { Connection, Keypair, PublicKey } from '@solana/web3.js'
import { readFileSync } from 'node:fs'
import { PROGRAM_ID, MAINNET_FOMO_COSIGNER } from '../program.mjs'
import { attestSale, crankSale, readSale, SALE_SIZE } from './attester.mjs'
import { passOver, SETTLED_EVERY } from './pass.mjs'
import { pacedOptions, rpsFromEnv } from '../rpc-pace.mjs'
import { alert, attesterStatus } from './alert.mjs'
import { writeFileSync } from 'node:fs'

/**
 * The attester's balance, written where the INDEXER can serve it.
 *
 * ⚠ A file rather than a shared connection, because only this process holds the attester key and
 * only the indexer answers HTTP. It is a health signal, not state: if it is stale or missing,
 * `/api/health` says "unknown" and nothing else changes.
 *
 * ⛔ Never throws. A read-only disk must not stop the watcher from attesting.
 */
const STATUS_FILE = process.env.ATTESTER_STATUS_FILE ?? 'data/attester.json'
const writeStatus = (s) => {
  try {
    writeFileSync(STATUS_FILE, JSON.stringify({ ...s, address: attester.publicKey.toBase58(), at: Math.floor(Date.now() / 1000) }))
  } catch { /* health reporting must never break the service it reports on */ }
}

const rpc = process.env.SOLANA_RPC_URL ?? 'http://127.0.0.1:8999'
// Paced: the key's burst limit is ~10/s and the indexer shares it (see rpc-pace.mjs).
const conn = new Connection(rpc, pacedOptions(rpsFromEnv(5), { commitment: 'confirmed' }))
const load = (f) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(f, 'utf8'))))
const attester = load(process.env.ATTESTER_KEY ?? 'keys/attester-mainnet.json')
const cranker = process.env.CRANKER_KEY ? load(process.env.CRANKER_KEY) : attester
const fomoCosigner = new PublicKey(process.env.FOMO_COSIGNER ?? MAINNET_FOMO_COSIGNER.toBase58())
const commitment = process.env.COMMITMENT ?? 'finalized'
const INTERVAL_MS = Number(process.env.INTERVAL_MS ?? 15_000)
/**
 * ⛔⛔ The watcher ALWAYS asks for hidden sales, and forces it here rather than trusting the URL
 * it was handed.
 *
 * `HIDDEN_SALES` takes a sale off Explore and off the homepage. The plain `/api/sales` honours
 * that — and the watcher's whole work list comes from this one call, so a filtered URL silently
 * removes the sale from the machine: no credits, no launch at the close, no delivery, no refund.
 * Buyers' money freezes and every health check stays green, because nothing failed. Nothing ran.
 *
 * Hiding is about the shop window. It must never be able to reach in here, so the `hidden=1` is
 * not configuration — an operator cannot leave it out of watcher.env and quietly break settlement.
 */
const SALES_URL = process.env.SALES_URL
  ? (() => { const u = new URL(process.env.SALES_URL); u.searchParams.set('hidden', '1'); return u.toString() })()
  : null
const lookupTable = process.env.LAUNCH_LUT
  ? (await conn.getAddressLookupTable(new PublicKey(process.env.LAUNCH_LUT))).value
  : null
if (!lookupTable) console.warn('⚠ no LAUNCH_LUT: sales will be attested and failed/refunded, but never launched')

const log = (sale) => (m) => console.log(new Date().toISOString(), sale.toBase58().slice(0, 8), m)

/**
 * The two tiers (see pass.mjs): open sales every pass, settled sales in a rotating slice and only
 * in full when their fingerprint moved. `quiet` is the memory between passes.
 */
const quiet = new Map()
const deps = {
  readSale: async (address) => readSale(await conn.getAccountInfo(new PublicKey(address), 'confirmed'), address),
  readHeld: async (deposit) => (await conn.getTokenAccountBalance(deposit, 'confirmed')).value.amount,
  attest: (address) => {
    const pubkey = new PublicKey(address)
    return attestSale(conn, attester, pubkey, { fomoCosigner, commitment, log: log(pubkey) })
  },
  crank: async (address) => {
    if (!lookupTable) return null
    const pubkey = new PublicKey(address)
    return crankSale(conn, cranker, pubkey, { lookupTable, fomoCosigner, log: log(pubkey) })
  },
  log: (address, m) => console.error(new Date().toISOString(), address.slice(0, 8), m),
}

for (let pass = 0; ; pass++) {
  try {
    // The sale list comes from our own indexer (SALES_URL), because public RPCs refuse
    // getProgramAccounts. With no indexer configured, ask the RPC and hope it allows it — every
    // row is then a real sale with an unknown status, and gets the full treatment.
    const rows = SALES_URL
      ? ((await (await fetch(SALES_URL)).json()).sales ?? [])
      : (await conn.getProgramAccounts(PROGRAM_ID, { commitment: 'confirmed', dataSlice: { offset: 0, length: 0 }, filters: [{ dataSize: SALE_SIZE }] }))
        .map(({ pubkey }) => ({ address: pubkey.toBase58(), authority: 'unknown', status: 0 }))
    const t = await passOver(rows, pass, quiet, deps)
    if (t.full > t.open || pass % SETTLED_EVERY === 0) {
      console.log(new Date().toISOString(), `pass ${pass}: ${t.open} open, ${t.settled} settled checked (${t.quiet} quiet), ${t.full} full`)
    }
    /*
     * The attester pays every credit, return and delivery. Say so before it runs dry — and say it
     * somewhere a person is, not only into journald.
     *
     * ⛔ A balance that could not be READ is `null`, and null is not low. An RPC that refused the
     * call says nothing about the wallet, and alerting on it teaches the reader to ignore this.
     */
    const lamports = await conn.getBalance(attester.publicKey).catch(() => null)
    const status = attesterStatus(lamports, attester.publicKey.toBase58())
    if (status) {
      writeStatus(status)
      if (status.low) {
        console.error(new Date().toISOString(), `⚠ ATTESTER LOW: ${status.sol} SOL left on ${attester.publicKey.toBase58()} (~${status.buyers} buyers)`)
        const r = await alert('attester-low', status.text)
        if (r.sent) console.error(new Date().toISOString(), 'alert sent')
        else if (r.why !== 'rate limited') console.error(new Date().toISOString(), `alert not sent: ${r.why}`)
      }
    }
  } catch (e) { console.error('listing sales failed:', e.message) }
  await new Promise((r) => setTimeout(r, INTERVAL_MS))
}
