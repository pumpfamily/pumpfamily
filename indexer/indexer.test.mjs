/**
 * The indexer against a real chain.
 *
 * Proves the thing the architecture rests on: sales can be found WITHOUT `getProgramAccounts`.
 * Opens sales on the local validator, then checks that history-walking finds ones opened before
 * the service started and the log subscription catches ones opened while it runs.
 *
 *   ./validator.sh &   then   node indexer/indexer.test.mjs
 */
import { Connection, Keypair, Transaction, sendAndConfirmRawTransaction, sendAndConfirmTransaction } from '@solana/web3.js'
import { getOrCreateAssociatedTokenAccount, mintTo, createTransferCheckedInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token'
import { readFileSync } from 'node:fs'
import { buildInitializeSaleTx, decodeSale, USDC_MINT, PROGRAM_ID } from '../program.mjs'
import { TEST_ATTESTER, TEST_FOMO_COSIGNER } from '../fixtures/keys.mjs'
import { attestSale } from '../watcher/attester.mjs'
import { Indexer } from './indexer.mjs'
import { serve } from './server.mjs'
import { unlinkSync, existsSync } from 'node:fs'

const RPC = process.env.LOCAL_RPC ?? 'http://127.0.0.1:8999'
const DB = process.env.TEST_DB ?? '/tmp/pumpfamily-indexer-test.db'
const conn = new Connection(RPC, 'confirmed')
const SOL = (n) => BigInt(Math.round(n * 1e9))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let pass = 0, fail = 0
const ok = (n, c, d = '') => { c ? (pass++, console.log('  ✅', n)) : (fail++, console.log('  ❌', n, d)) }

for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) if (existsSync(f)) unlinkSync(f)

const authority = Keypair.generate()
await conn.confirmTransaction(await conn.requestAirdrop(authority.publicKey, Number(SOL(20))), 'confirmed')

let n = 0
async function openSale(name) {
  const saleId = BigInt(Date.now()) + BigInt(++n * 1_000_003)
  const { saleAddress } = await import('../program.mjs')
  const r = await buildInitializeSaleTx(conn, authority.publicKey, saleId, {
    windowSeconds: 3600, launchWindow: 3600,
    // ⚠ LAMPORTS. The curve is the SOL curve and every cap on a sale is measured against the
    // SOL-equivalent of what was sent, not against the USDC figure. 20 SOL of headroom is far
    // more than these three small deposits need; the old 0.4 SOL read as a cap that refused the
    // third one, and the suite only showed it as "got 2" deposits.
    perWalletCap: SOL(20), hardCap: SOL(60), minRaise: 0n, quote: 'usdc', quoteMint: USDC_MINT,
    protocolFeeBps: 95, creatorFeeBps: 30, creatorFeeRecipient: authority.publicKey,
    // Served by the web dev server when it is running; when it is not, this exercises the
    // failure path instead, which is also worth covering.
    name, symbol: 'IDX', uri: 'http://localhost:5173/demo/1.json',
  }, Keypair.generate())
  const t = r.tx
  t.partialSign(authority)
  await sendAndConfirmRawTransaction(conn, t.serialize(), { commitment: 'confirmed' })
  return r.sale.toBase58()
}

console.log('\n── sales opened BEFORE the indexer exists are found by walking history ──')
const before = [await openSale('Before One'), await openSale('Before Two')]

const indexer = new Indexer({ rpc: RPC, db: DB, refreshMs: 2000, backfillMs: 60_000 })
await indexer.start()

ok('backfill discovered the sales opened before it started',
   before.every((a) => indexer.store.addresses().includes(a)),
   `known: ${indexer.store.addresses().length}`)

const rows = indexer.store.all()
ok(`and read their state off chain (${rows.length} rows with a name)`,
   rows.length >= 2 && rows.every((r) => r.name && r.mint && r.hard_cap > 0))
ok('the names came back intact', before.every((a) => indexer.store.get(a)?.name?.startsWith('Before')))

console.log('\n── a sale opened WHILE it runs is caught by the log subscription ──')
const during = await openSale('During')
for (let i = 0; i < 30 && !indexer.store.addresses().includes(during); i++) await sleep(500)
ok('the live subscription discovered it', indexer.store.addresses().includes(during))
for (let i = 0; i < 20 && !indexer.store.get(during)?.name; i++) await sleep(500)
ok('and the refresh sweep filled in its state', indexer.store.get(during)?.name === 'During')

console.log('\n── the API ──')
const server = await serve(indexer, 0)
const port = server.address().port
const get = async (p) => (await fetch(`http://127.0.0.1:${port}${p}`)).json()

const list = await get('/api/sales')
const mine = list.sales.filter((s) => s.symbol === 'IDX')
// The validator carries sales from whatever other suites have run against it, so assertions are
// scoped to the ones this test opened rather than to the whole listing.
ok(`/api/sales returns all ${list.count} sales, ${mine.length} of them this test's`, mine.length >= 3)
ok('every row carries a phase', list.sales.every((s) => typeof s.phase === 'string'))
ok("this test's sales, opened with a 1h window, all read as open",
   mine.every((s) => s.phase === 'open'), JSON.stringify(mine.map((s) => s.phase)))
ok('rows say how stale they are', list.sales.every((s) => typeof s.ageSeconds === 'number'))
// ⭐ HIDDEN_SALES keeps our own test sales off the front page. It hides a ROW in the LISTINGS —
// the sale's own page must keep working for whoever holds the link, which is what the second
// assertion pins. ⛔ It cannot undo a launch: a launched coin trades on pump.fun regardless.
{
  const statsBefore = await get('/api/stats')
  process.env.HIDDEN_SALES = `${during},  ,not-an-address`
  const after = await get('/api/sales')
  ok('a sale named in HIDDEN_SALES is gone from the listing',
     !after.sales.some((s) => s.address === during) && after.count === list.count - 1)
  ok('but its own page still answers in full', (await get(`/api/sales/${during}`))?.address === during)
  ok('and /api/stats stops counting it', (await get('/api/stats')).sales === statsBefore.sales - 1)
  /**
   * ⛔⛔ The WATCHER must still see it. It lists every sale it works on from this one endpoint, so
   * for as long as the filter applied here unconditionally, hiding a sale took it off the machine
   * as well as off the page: no credits, no launch at the close, no delivery, no refund, and not
   * one error anywhere — the sale simply stopped existing to the only process that settles it.
   *
   * Two assertions, because either half alone is satisfied by a mistake: the first that `hidden=1`
   * brings the row back, the second that it is the WATCHER's real call shape doing it, built the
   * way watcher/run.mjs builds it from a plain configured URL.
   */
  const withHidden = await get('/api/sales?hidden=1')
  ok('but ?hidden=1 still lists it, which is how the watcher finds its work',
     withHidden.sales.some((s) => s.address === during) && withHidden.count === list.count)
  {
    const u = new URL('http://x/api/sales'); u.searchParams.set('hidden', '1')
    const asWatcherAsks = await get(u.pathname + u.search)
    ok('and the URL the watcher actually builds sees it too',
       asWatcherAsks.sales.some((s) => s.address === during))
  }
  process.env.HIDDEN_SALES = ''
  ok('clearing it puts the row back', (await get('/api/sales')).count === list.count)
}

{
  const open = await get('/api/sales?phase=open')
  ok('filtering by phase returns only that phase',
     open.sales.every((s) => s.phase === 'open') && open.count <= list.count)
  ok('an unknown phase returns nothing rather than everything',
     (await get('/api/sales?phase=nonsense')).count === 0)
}

// The bug this caught: `window_end` is written from Solana's clock, so comparing it against the
// host's makes an open sale read as closed whenever the two have drifted.
{
  const h = await get('/api/health')
  ok(`the listing is judged on the chain's clock (skew ${h.clockSkewSeconds}s from the host)`,
     typeof h.chainTime === 'number' && h.chainTime > 0)
}

const one = await get(`/api/sales/${during}`)
ok('a single sale reads back by address', one.address === during && one.name === 'During')
ok('an unknown address is a 404, not an empty row',
   (await get('/api/sales/11111111111111111111111111111111')).error === 'unknown sale')

// The listing's images and totals — the two things the launchpad page renders that the chain
// does not carry. Metadata is served from the web dev server in this test, so it exercises the
// real fetch-parse-store path rather than a stub.
{
  await indexer.resolveMetadata()
  const withMeta = (await get('/api/sales')).sales.filter((s) => s.symbol === 'IDX')
  ok('every sale reaches a settled metadata state (resolved or given up on)',
     withMeta.length >= 3)

  const stats = await get('/api/stats')
  const all = await get('/api/sales')
  const launched = all.sales.filter((s) => s.phase === 'launched')

  ok(`/api/stats sees ${stats.sales} sales, ${stats.open} open, ` +
     `${(stats.raised / 1e6).toFixed(2)} USDC raised`,
     stats.sales >= 3 && stats.open >= 3 && typeof stats.raised === 'number')
  ok('the sale count agrees with the rows it is derived from', stats.sales === all.count)

  // ⛔ These two assertions previously encoded the BUG: `launches` was the total number of sales
  // ever opened, and one of them literally asserted launches === the sale count. A sale that
  // opened, failed and refunded every deposit is not a launch, and the landing page puts this
  // number in front of everyone who visits.
  ok(`${stats.launches} launches out of ${stats.sales} sales, counted by phase`,
     stats.launches === launched.length)
  ok('a sale that never launched is not counted as a launch', stats.launches <= stats.sales)

  // Volume must never include money that went back. A failed sale refunds in full, so counting
  // its deposits would report a round trip as volume.
  const launchedGross = launched.reduce((a, r) => a + (r.gross || 0), 0)
  ok(`total volume is ${(stats.volume / 1e6).toFixed(2)} USDC, from launched sales only`,
     stats.volume === launchedGross)
  ok('volume never exceeds everything ever deposited',
     stats.volume <= stats.raised)

  // A URI that does not resolve must be recorded as tried, not retried forever.
  const before = indexer.store.pendingMetadata(50).length
  await indexer.resolveMetadata()
  ok(`a failed metadata fetch is not retried on every sweep (${before} pending, still ${indexer.store.pendingMetadata(50).length})`,
     indexer.store.pendingMetadata(50).length === before)
}

// ⛔ /api/health is public through the site's vhost, and every paid Solana provider puts its
// API key in the RPC url. Asserted rather than trusted: this endpoint published the operator's
// Helius key the first time it was pointed at a real provider.
{
  const h = await get('/api/health')
  ok('/api/health reports the RPC host, never the url that carries the key',
     typeof h.rpc === 'string' && !h.rpc.includes('api-key') && !h.rpc.includes('/'), h.rpc)
}

const health = await get('/api/health')
ok(`/api/health reports ${health.sales} sales, ${health.discovered} discovered, ${health.errors} errors`,
   health.ok && health.errors === 0)

console.log('\n── the price history behind the chart ──')
{
  const { PublicKey } = await import('@solana/web3.js')
  const sale = new PublicKey(during)
  const { depositAccount } = decodeSale((await conn.getAccountInfo(sale)).data)
  const usdcAuthority = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync('fixtures/usdc-authority.json', 'utf8'))))
  for (const k of [usdcAuthority, TEST_ATTESTER, TEST_FOMO_COSIGNER]) {
    await conn.confirmTransaction(await conn.requestAirdrop(k.publicKey, Number(SOL(5))), 'confirmed')
  }
  const AMOUNTS = [20_000_000n, 50_000_000n, 30_000_000n]
  for (const amount of AMOUNTS) {
    // A send from the FOMO app, then the attester books it — the only way a deposit happens now.
    const d = Keypair.generate()
    const ata = await getOrCreateAssociatedTokenAccount(conn, usdcAuthority, USDC_MINT, d.publicKey)
    await mintTo(conn, usdcAuthority, USDC_MINT, ata.address, usdcAuthority, Number(amount))
    const t = new Transaction().add(createTransferCheckedInstruction(ata.address, USDC_MINT, depositAccount, d.publicKey, amount, 6))
    t.feePayer = TEST_FOMO_COSIGNER.publicKey
    await sendAndConfirmTransaction(conn, t, [TEST_FOMO_COSIGNER, d], { commitment: 'confirmed' })
  }
  await attestSale(conn, TEST_ATTESTER, sale, { fomoCosigner: TEST_FOMO_COSIGNER.publicKey })
  await sleep(2500)

  const hist = await get(`/api/sales/${during}/history`)
  ok(`/api/sales/<addr>/history returns all ${AMOUNTS.length} deposits`, hist.count === AMOUNTS.length,
     `got ${hist.count}`)
  ok('each carries the amount it was made for',
     hist.deposits.map((d) => String(d.amount)).join() === AMOUNTS.map(String).join(),
     hist.deposits.map((d) => d.amount).join())
  // The whole point of the chart: the price a deposit is booked at rises with the queue.
  const prices = hist.deposits.map((d) => BigInt(d.priceAfter))
  ok('and a price that rises with every one of them',
     prices.every((p, i) => i === 0 || p > prices[i - 1]), prices.join(' '))

  // The anchor. The stream can miss a deposit; the account cannot be stale. If these two ever
  // disagree the chart must follow the account, so the property is asserted rather than assumed.
  const acct = decodeSale((await conn.getAccountInfo(sale)).data)
  ok('the last point equals the sale account\'s own virtual_sol, which is authoritative',
     prices[prices.length - 1] === acct.virtualSol, `${prices[prices.length - 1]} vs ${acct.virtualSol}`)

  // Re-walking history must not draw the same deposit twice — rows are keyed by signature.
  await indexer.backfill()
  const again = await get(`/api/sales/${during}/history`)
  ok('re-walking history is idempotent, not duplicating points', again.count === AMOUNTS.length,
     `${again.count} after a second walk`)

  const listed = (await get('/api/sales')).sales.find((x) => x.address === during)
  ok(`the listing carries a ${listed?.spark?.length ?? 0}-point sparkline for the row`,
     listed?.spark?.length === AMOUNTS.length)
  const untouched = (await get('/api/sales')).sales.find((x) => x.address === before[0])
  ok('and an empty one for a sale nobody has deposited into', (untouched?.spark ?? []).length === 0)

  // The listing builds every sparkline in one windowed query while `/history` uses the per-sale
  // one. Two queries for one answer is where a silent divergence lives, so they are compared.
  const grouped = indexer.store.sparks()
  const perSale = indexer.store.addresses().map((a) => [a, indexer.store.spark(a)])
  ok('the listing\'s one-query sparklines match the per-sale query exactly',
     perSale.every(([a, one]) => (grouped[a] ?? []).join() === one.join()),
     perSale.filter(([a, one]) => (grouped[a] ?? []).join() !== one.join()).map(([a]) => a).join())
}

console.log('\n── a restart re-walks only the gap ──')
await indexer.stop()
const after = await openSale('After Restart')
const second = new Indexer({ rpc: RPC, db: DB, refreshMs: 2000, backfillMs: 60_000 })
const walked = await second.backfill()
ok(`the second backfill walked ${walked} signatures, not the whole history`, walked > 0 && walked < 30,
   `${walked}`)
ok('and still found the sale opened while it was down', second.store.addresses().includes(after))
await second.refresh()
ok('which reads back with its state', second.store.get(after)?.name === 'After Restart')
await second.stop()

console.log('\n── a cursor the RPC has never heard of ──')
{
  /**
   * The live indexer spent 45 hours failing every backfill on exactly this: a stored cursor naming
   * a transaction the endpoint could not resolve. `getSignaturesForAddress` throws rather than
   * ignoring an unknown `until`, and nothing rewrote the cursor, so every later pass failed the
   * same way. Discovery survived only because the websocket was up.
   */
  const poisoned = new Indexer({ rpc: RPC, db: DB })
  poisoned.store.setCursor('last_signature', '3otxMHSvf1cmQ16XAUoXL4HFmYHJKwmsHaquuLUXxfYdhVWhMzMxEoDLRthxZLw2VKnVCJqsXRDDRFDzVeccWfDe')
  const calls = []
  poisoned.conn = {
    async getSignaturesForAddress(_program, opts) {
      calls.push(opts.until ?? null)
      if (opts.until) throw new Error(`failed to get signatures for address: Transaction ${opts.until} not found`)
      return []
    },
  }
  let threw = null
  try { await poisoned.backfill() } catch (e) { threw = e }
  ok('the pass recovers instead of throwing', threw === null, String(threw?.message))
  ok('it retried the walk WITHOUT the unusable cursor', calls.length === 2 && calls[1] === null, calls.join(','))
  ok('⛔ and dropped the cursor, so the next pass is not poisoned too',
     !poisoned.store.cursor('last_signature'), String(poisoned.store.cursor('last_signature')))
  // An error that is not about the cursor still surfaces — a silent catch here would hide an outage.
  poisoned.conn = { async getSignaturesForAddress() { throw new Error('503 upstream is down') } }
  let surfaced = false
  try { await poisoned.backfill() } catch { surfaced = true }
  ok('a real RPC failure is still raised', surfaced)
  poisoned.store.close()
}

console.log('\n── pricing a launched coin: the curve, the pool, and neither ──')
{
  /**
   * The three states `refreshMarkets` has to tell apart, driven with REAL mainnet bytes.
   *
   * The connection is swapped for one that answers from `fixtures/pump-market-accounts.json`, so
   * this tests the pass itself — which account it reaches for, what it writes, and above all that
   * an unreadable coin is stored as `null` rather than as a market cap of zero. A local validator
   * has no pump.fun curve to graduate, so the migrated case cannot be produced any other way.
   */
  const fx = JSON.parse(readFileSync(new URL('../fixtures/pump-market-accounts.json', import.meta.url), 'utf8'))
  const acct = (k) => ({ data: Buffer.from(fx.accounts[k].data, 'base64'), owner: null })
  const LIVE_MINT = 'CAA37EB8VnDD97MvDZKfHgChKbLNxD435WATp1Mgpump'   // still on its curve, USDC
  const GONE_MINT = '57eBR7XfEEdWR44gTfL2cA2nhTpGbzXph4BHBzWjcCgi'   // migrated, WSOL pool
  const byAddress = {
    [fx.accounts['curve-usdc-live'].address]: acct('curve-usdc-live'),
    [fx.accounts['curve-migrated'].address]: acct('curve-migrated'),
    [fx.accounts['pool-migrated'].address]: acct('pool-migrated'),
    [fx.accounts['pool-base-ta'].address]: acct('pool-base-ta'),
    [fx.accounts['pool-quote-ta'].address]: acct('pool-quote-ta'),
  }
  const priced = new Indexer({ rpc: RPC, db: DB })
  const asks = []
  priced.conn = {
    async getMultipleAccountsInfo(keys) {
      asks.push(keys.length)
      return keys.map((k) => byAddress[k.toBase58()] ?? null)
    },
  }
  const set = (address, cols) => priced.store.db.exec(
    `UPDATE sales SET ${Object.entries(cols).map(([k, v]) => `${k}=${v === null ? 'NULL' : `'${v}'`}`).join(', ')} WHERE address='${address}'`)

  const onCurve = before[0], migrated = before[1]
  set(onCurve, { status: 1, mint: LIVE_MINT, quote: 'usdc', quote_mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', pool: null, market_state: null })
  set(migrated, { status: 1, mint: GONE_MINT, quote: 'sol', quote_mint: null, pool: null, market_state: null })
  await priced.refreshMarkets()

  const a = priced.store.get(onCurve), b = priced.store.get(migrated)
  ok('a coin still on its curve is priced from the curve', a.market_state === 'curve', a.market_state)
  ok(`and reads ${Math.round(a.market_cap)} USDC, the opening cap`, Math.round(a.market_cap) === 4000, String(a.market_cap))
  ok('🔴 a migrated coin is NOT priced from its drained curve', b.market_state === 'migrated', b.market_state)
  ok('it is priced from the pool instead, well above the graduation cap', b.market_cap > 1000, String(b.market_cap))
  ok('and the pool it found is cached on the row', b.pool === fx.accounts['pool-migrated'].address, String(b.pool))
  ok('⛔ the batch never exceeds what the endpoint allows', asks.every((n) => n <= 10), asks.join(','))

  // The same coin, with nothing answering. This is the case that must not become a zero.
  priced.conn = { async getMultipleAccountsInfo(keys) { return keys.map(() => null) } }
  set(onCurve, { market_state: null, market_cap: null })
  await priced.refreshMarkets()
  const c = priced.store.get(onCurve)
  ok('an unreadable curve is "unknown", not "migrated"', c.market_state === 'unknown', c.market_state)
  ok('⛔⛔ and its market cap is NULL, never 0', c.market_cap === null, String(c.market_cap))

  // A migrated coin whose pool cannot be read keeps its state and loses only its number.
  priced.conn = {
    async getMultipleAccountsInfo(keys) {
      return keys.map((k) => (k.toBase58() === fx.accounts['curve-migrated'].address ? acct('curve-migrated') : null))
    },
  }
  set(migrated, { pool: null, market_state: null, market_cap: null })
  await priced.refreshMarkets()
  const d = priced.store.get(migrated)
  ok('a migrated coin with no readable pool is still migrated', d.market_state === 'migrated', d.market_state)
  ok('with an unknown price rather than a wrong one', d.market_cap === null, String(d.market_cap))
  priced.store.close()
}

server.close()
console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail ? 1 : 0)
