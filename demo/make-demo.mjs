/**
 * Fills the local validator with sales in every state the site has to render: open with FOMO
 * deposits, nearly full, closing in 90 seconds, untouched, a broken image, launched and delivered,
 * and failed and refunded. Uses the TEST attester and TEST FOMO co-signer, so it needs a
 * `--features test-attester` build (./run-integration.sh leaves one running).
 *
 *   node demo/serve.mjs &  node demo/make-demo.mjs
 *
 * Prints the lookup table address — pass it to the site as VITE_LAUNCH_LUT.
 */
import { Connection, Keypair, Transaction, AddressLookupTableProgram, sendAndConfirmTransaction } from '@solana/web3.js'
import { getOrCreateAssociatedTokenAccount, mintTo, createTransferCheckedInstruction } from '@solana/spl-token'
import { readFileSync } from 'node:fs'
import { buildInitializeSaleTx, saleAddress, launchLookupAddresses, decodeSale, USDC_MINT } from '../program.mjs'
import { TEST_ATTESTER, TEST_FOMO_COSIGNER } from '../fixtures/keys.mjs'
import { attestSale, crankSale, chainTime } from '../watcher/attester.mjs'

const conn = new Connection(process.env.LOCAL_RPC ?? 'http://127.0.0.1:8999', 'confirmed')
const META = 'http://localhost:5242'
const USDC = (n) => BigInt(Math.round(n * 1e6))
const SOL = (n) => BigInt(Math.round(n * 1e9))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const send = (ixs, signers) => sendAndConfirmTransaction(conn, new Transaction().add(...ixs), signers, { commitment: 'confirmed' })
const fund = async (pk, sol) => conn.confirmTransaction(await conn.requestAirdrop(pk, sol * 1e9), 'confirmed')
const usdcAuthority = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync('fixtures/usdc-authority.json', 'utf8'))))
const creator = Keypair.generate()
await Promise.all([creator, usdcAuthority, TEST_ATTESTER, TEST_FOMO_COSIGNER].map((k) => fund(k.publicKey, 50)))

const [createLut, lutAddress] = AddressLookupTableProgram.createLookupTable({
  authority: creator.publicKey, payer: creator.publicKey, recentSlot: await conn.getSlot('finalized') })
await send([createLut], [creator])
// In chunks: 31 addresses do not fit one extend — see make-lookup-table.mjs.
for (const chunk of (() => { const a = launchLookupAddresses(USDC_MINT), out = []; for (let i = 0; i < a.length; i += 15) out.push(a.slice(i, i + 15)); return out })()) {
  await send([AddressLookupTableProgram.extendLookupTable({ payer: creator.publicKey, authority: creator.publicKey, lookupTable: lutAddress, addresses: chunk })], [creator])
}
await sleep(1500)
const lookupTable = (await conn.getAddressLookupTable(lutAddress)).value

async function fomoBuy(depositAccount, amount) {
  const d = Keypair.generate()
  const ata = await getOrCreateAssociatedTokenAccount(conn, usdcAuthority, USDC_MINT, d.publicKey)
  await mintTo(conn, usdcAuthority, USDC_MINT, ata.address, usdcAuthority, Number(amount))
  const tx = new Transaction().add(createTransferCheckedInstruction(ata.address, USDC_MINT, depositAccount, d.publicKey, amount, 6))
  tx.feePayer = TEST_FOMO_COSIGNER.publicKey
  await sendAndConfirmTransaction(conn, tx, [TEST_FOMO_COSIGNER, d], { commitment: 'confirmed' })
}

async function sale({ name, symbol, n, window, hardCap = 10000, minRaise = 200, buys = [] }) {
  const saleId = BigInt(Date.now()) + BigInt(Math.floor(Math.random() * 1e6))
  const r = await buildInitializeSaleTx(conn, creator.publicKey, saleId, {
    windowSeconds: window, launchWindow: 7200,
    // ⚠ LAMPORTS. Every cap on a sale is the SOL curve's, because that is what the raise buys;
    // `minRaise` alone is the USDC that came in, because that is what a refund returns.
    perWalletCap: SOL(20), hardCap: SOL(60), minRaise: USDC(minRaise),
    protocolFeeBps: 95, creatorFeeBps: 30, creatorFeeRecipient: creator.publicKey,
    name, symbol, uri: `${META}/${n}.json`, quote: 'usdc', quoteMint: USDC_MINT,
  }, Keypair.generate())
  r.tx.partialSign(creator)
  await conn.confirmTransaction(await conn.sendRawTransaction(r.tx.serialize()), 'confirmed')
  for (const b of buys) await fomoBuy(r.depositAccount, USDC(b))
  await attestSale(conn, TEST_ATTESTER, r.sale, { fomoCosigner: TEST_FOMO_COSIGNER.publicKey, settleSeconds: 2 })
  console.log(`  ${symbol.padEnd(7)} ${String(buys.length).padStart(2)} buys  ${window}s window  -> ${r.sale.toBase58()}`)
  return r
}

console.log('\nopening demo sales…')
await sale({ name: 'Tendie Cat', symbol: 'TENDIE', n: 1, window: 3 * 3600, buys: [120, 90, 60, 45, 30] })
await sale({ name: 'Fomo Doge', symbol: 'FOGE', n: 2, window: 2 * 3600, hardCap: 700, buys: [110, 110, 105, 100, 95, 90, 80] })
await sale({ name: 'Last Call', symbol: 'LASTCL', n: 3, window: 90, buys: [80, 40] })
await sale({ name: 'Broken Art', symbol: 'BROKE', n: 4, window: 5400, buys: [25] })
await sale({ name: 'Window Shopper', symbol: 'WNDW', n: 5, window: 2400 })
const launched = await sale({ name: 'Launched Frog', symbol: 'LFROG', n: 6, window: 60, buys: [100, 80, 60] })
const failed = await sale({ name: 'Missed Minimum', symbol: 'MISS', n: 7, window: 60, minRaise: 5000, buys: [40] })

console.log('\nwaiting for the short windows to close…')
const end = Number(decodeSale((await conn.getAccountInfo(failed.sale)).data).windowEnd) + 3
while ((await chainTime(conn)) < end) await sleep(1000)
for (const r of [launched, failed]) {
  await attestSale(conn, TEST_ATTESTER, r.sale, { fomoCosigner: TEST_FOMO_COSIGNER.publicKey, settleSeconds: 2 })
  console.log('  ', await crankSale(conn, TEST_ATTESTER, r.sale, { lookupTable, fomoCosigner: TEST_FOMO_COSIGNER.publicKey }))
}
console.log(`\nVITE_LAUNCH_LUT=${lutAddress.toBase58()}\n`)
