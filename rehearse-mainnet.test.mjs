/**
 * The driver for rehearse-mainnet.sh. It only does what outsiders do — a creator opens a sale, FOMO
 * users and a Phantom user send USDC — and then waits for the RUNNING services (indexer + watcher
 * on the production attester key) to do everything else.
 */
import { Connection, Keypair, Transaction, sendAndConfirmTransaction } from '@solana/web3.js'
import { getOrCreateAssociatedTokenAccount, mintTo, createTransferCheckedInstruction, getAccount, getAssociatedTokenAddressSync } from '@solana/spl-token'
import { readFileSync } from 'node:fs'
import { buildInitializeSaleTx, saleAddress, decodeSale, positionAddress, decodePosition, USDC_MINT, PROGRAM_ID, deliverable } from './program.mjs'
import { TOKEN_2022_PROGRAM_ID } from '@solana/spl-token'
import { TEST_FOMO_COSIGNER } from './fixtures/keys.mjs'

const conn = new Connection(process.env.LOCAL_RPC, 'confirmed')
const INDEXER = process.env.INDEXER
const USDC = (n) => BigInt(Math.round(n * 1e6))
const SOL = (n) => BigInt(Math.round(n * 1e9))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0, fail = 0
const ok = (n, c, d = '') => { c ? (pass++, console.log('  ✅', n)) : (fail++, console.log('  ❌', n, d)) }
const fund = async (pk, sol) => conn.confirmTransaction(await conn.requestAirdrop(pk, sol * 1e9), 'confirmed')
async function until(label, fn, seconds = 240) {
  const end = Date.now() + seconds * 1000
  for (;;) {
    try { const v = await fn(); if (v) return v } catch { /* not yet */ }
    if (Date.now() > end) throw new Error(`timed out waiting for: ${label}`)
    await sleep(2000)
  }
}
const usdcOf = async (o) => (await getAccount(conn, getAssociatedTokenAddressSync(USDC_MINT, o))).amount

ok('the program on this chain is the one deployed by the script', (await conn.getAccountInfo(PROGRAM_ID))?.executable === true)

const usdcAuthority = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync('fixtures/usdc-authority.json', 'utf8'))))
const creator = Keypair.generate()
await Promise.all([usdcAuthority, creator, TEST_FOMO_COSIGNER].map((k) => fund(k.publicKey, 5)))

const saleId = BigInt(Date.now())
const r = await buildInitializeSaleTx(conn, creator.publicKey, saleId, {
  // ⚠ LAMPORTS: the curve is the SOL curve and buyers pay USDC, which is converted at the swap
  // pool's spot when each buy is credited. A USDC figure here is a cap a thousand times too small.
  windowSeconds: 60, launchWindow: 3600, perWalletCap: SOL(20), hardCap: SOL(60), minRaise: USDC(100),
  protocolFeeBps: 95, creatorFeeBps: 30, creatorFeeRecipient: creator.publicKey,
  name: 'Rehearsal', symbol: 'REHRS', uri: 'https://pump.family/demo.json', quote: 'usdc', quoteMint: USDC_MINT,
}, Keypair.generate())
r.tx.partialSign(creator)
await conn.confirmTransaction(await conn.sendRawTransaction(r.tx.serialize()), 'confirmed')
ok('a creator opened a sale from an ordinary wallet', !!(await conn.getAccountInfo(r.sale)))

async function wallet(usdc) {
  const w = Keypair.generate()
  await fund(w.publicKey, 0.01)
  const ata = await getOrCreateAssociatedTokenAccount(conn, usdcAuthority, USDC_MINT, w.publicKey)
  await mintTo(conn, usdcAuthority, USDC_MINT, ata.address, usdcAuthority, Number(USDC(usdc)))
  return w
}
const transfer = (from, amount) => new Transaction().add(createTransferCheckedInstruction(
  getAssociatedTokenAddressSync(USDC_MINT, from.publicKey), USDC_MINT, r.depositAccount, from.publicKey, amount, 6))
const alice = await wallet(200), bob = await wallet(200), phantom = await wallet(200)
for (const [w, amt] of [[alice, 60], [bob, 100]]) {
  const t = transfer(w, USDC(amt)); t.feePayer = TEST_FOMO_COSIGNER.publicKey
  await sendAndConfirmTransaction(conn, t, [TEST_FOMO_COSIGNER, w], { commitment: 'confirmed' })
}
await sendAndConfirmTransaction(conn, transfer(phantom, USDC(50)), [phantom], { commitment: 'confirmed' })
console.log('   sent: alice 60 + bob 100 from "FOMO", phantom 50 from a plain wallet')

await until('the indexer lists the sale', async () => ((await (await fetch(`${INDEXER}/api/sales`)).json()).sales ?? []).some((s) => s.address === r.sale.toBase58()))
ok('the indexer found the sale on its own', true)

await until('the watcher credits both FOMO sends', async () => decodeSale((await conn.getAccountInfo(r.sale)).data).gross === USDC(160))
ok('the watcher service credited exactly the two FOMO sends (160 USDC)', true)
await until('the Phantom send is returned', async () => (await usdcOf(phantom.publicKey)) === USDC(200))
ok('and returned the Phantom send in full', true)

console.log('   waiting for the window to close, credits to settle, and the launch…')
await until('launch', async () => decodeSale((await conn.getAccountInfo(r.sale)).data).status === 1, 300)
ok('the watcher launched the sale on pump.fun after the window', true)

const sale = decodeSale((await conn.getAccountInfo(r.sale)).data)
const mint = sale.mint
ok(`the raise was swapped to SOL before the launch (${sale.solIn} lamports)`, sale.solIn > 0n)
// ⛔ Token-2022 since 21 Sep 2026: the launch is `create_v2`, quoted in WSOL. The coin is still
// SOL-paired — pump.fun writes `quote_mint` on the curve as all-zeroes for the native mint.
ok('and the coin is a Token-2022 mint — what pump.fun\'s own launches are',
   (await conn.getAccountInfo(mint)).owner.equals(TOKEN_2022_PROGRAM_ID))
for (const [name, w] of [['alice', alice], ['bob', bob]]) {
  const p = decodePosition((await conn.getAccountInfo(positionAddress(r.sale, w.publicKey))).data)
  const owed = deliverable(p, sale)
  const got = await until(`${name}'s tokens`, async () => {
    const a = await getAccount(conn, getAssociatedTokenAddressSync(mint, w.publicKey, true, TOKEN_2022_PROGRAM_ID), 'confirmed', TOKEN_2022_PROGRAM_ID)
    return a.amount === owed ? a.amount : null
  })
  // ⭐ The delivered figure is the QUOTED allocation scaled by what the raise actually bought at
  // the swap — one factor for everyone. `deliverable` is the program's own arithmetic.
  ok(`${name} received exactly what they are owed (${got}) without signing anything`, got === deliverable(p, sale))
}
ok('the creator holds no tokens', await getAccount(conn, getAssociatedTokenAddressSync(mint, creator.publicKey, true, TOKEN_2022_PROGRAM_ID), 'confirmed', TOKEN_2022_PROGRAM_ID).then(() => false, () => true))

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
