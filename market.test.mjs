/**
 * The three places a coin's price can live, tested against bytes pump.fun actually wrote.
 *
 * `fixtures/pump-market-accounts.json` holds REAL mainnet accounts, read on 18 Sep 2026: a live
 * USDC bonding curve, a curve that has migrated, and the AMM pool that curve migrated into with
 * both of its token accounts. Testing the decoders against invented bytes would prove only that
 * the test and the decoder agree with each other.
 *
 * The property this file exists for: **a migrated curve reads all zeroes**, so anything that
 * prices a coin from its curve without checking `complete` reports a live coin as worth 0.
 */
import { readFileSync } from 'node:fs'
import { PublicKey } from '@solana/web3.js'
import {
  decodeBondingCurve, decodePool, tokenAccountAmount, marketCapFromCurve, marketCapFromPool,
  bondingCurveAddress, poolAddress, poolAuthority, PUMP_AMM,
} from './market.mjs'
import { openMarketCap } from './curve.mjs'

let pass = 0, fail = 0
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log('  ✅', name) }
  else { fail++; console.log('  ❌', name, detail) }
}

const fx = JSON.parse(readFileSync(new URL('./fixtures/pump-market-accounts.json', import.meta.url), 'utf8'))
const bytes = (k) => Buffer.from(fx.accounts[k].data, 'base64')

console.log('\n── a live bonding curve, quoted in USDC ──')
{
  const curve = decodeBondingCurve(bytes('curve-usdc-live'))
  ok('it is not complete', curve.complete === false)
  ok('its quote mint decodes as USDC',
     curve.quoteMint?.toBase58() === 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', String(curve.quoteMint))
  ok('the virtual quote reserve is the 4,292 USDC the curve opens at',
     curve.virtualQuote === 4_292_000_008n, String(curve.virtualQuote))
  ok('79.31% of supply is on the curve', curve.realToken === 793_100_000_000_000n, String(curve.realToken))
  const cap = marketCapFromCurve(curve, 'usdc')
  ok(`it prices at ${Math.round(cap)} USDC, the opening cap`,
     Math.abs(cap - openMarketCap('usdc')) < 1, `${cap} vs ${openMarketCap('usdc')}`)
  ok('⚠ and the SAME bytes read as SOL give a thousandfold different answer — the quote is not cosmetic',
     Math.abs(marketCapFromCurve(curve, 'sol') / cap - 1) > 0.5)
}

console.log('\n── the same account after the coin migrated ──')
{
  const curve = decodeBondingCurve(bytes('curve-migrated'))
  ok('complete is set', curve.complete === true)
  ok('🔴 every reserve reads ZERO — the curve was drained into the pool',
     curve.virtualToken === 0n && curve.virtualQuote === 0n && curve.realToken === 0n && curve.realQuote === 0n)
  ok('⛔ so pricing it from the curve is REFUSED rather than returning that zero',
     marketCapFromCurve(curve, 'sol') === null)
  ok('the account is a different length from the live one, and decoding still holds',
     bytes('curve-migrated').length !== bytes('curve-usdc-live').length)
}

console.log('\n── the pool it migrated into ──')
{
  const pool = decodePool(bytes('pool-migrated'))
  const base = new PublicKey('57eBR7XfEEdWR44gTfL2cA2nhTpGbzXph4BHBzWjcCgi')
  const wsol = new PublicKey('So11111111111111111111111111111111111111112')
  ok('base and quote mints decode', pool.baseMint.equals(base) && pool.quoteMint.equals(wsol))
  ok('it is pool index 0', pool.index === 0)
  ok('its creator is the mint\'s pool-authority PDA', pool.creator.equals(poolAuthority(base)))
  ok('⭐ the pool address DERIVES, so finding it needs no getProgramAccounts',
     poolAddress(base, wsol, 0).toBase58() === fx.accounts['pool-migrated'].address,
     poolAddress(base, wsol, 0).toBase58())
  ok('the derived address belongs to the AMM program',
     fx.accounts['pool-migrated'].owner === PUMP_AMM.toBase58())

  const baseAmt = tokenAccountAmount(bytes('pool-base-ta'))
  const quoteAmt = tokenAccountAmount(bytes('pool-quote-ta'))
  ok('the reserves come from the token accounts the pool names, not from the pool itself',
     baseAmt > 0n && quoteAmt > 0n, `${baseAmt} / ${quoteAmt}`)
  const cap = marketCapFromPool(baseAmt, quoteAmt, 'sol')
  ok(`it prices at ${cap.toFixed(0)} SOL`, cap > 1000 && cap < 10_000, String(cap))
  ok('⛔ and that is far above the ~411 SOL graduation cap the curve would have frozen at',
     cap > 411)
  ok('an empty side is unpriceable, not free', marketCapFromPool(0n, quoteAmt, 'sol') === null
     && marketCapFromPool(baseAmt, 0n, 'sol') === null)
}

console.log('\n── addresses ──')
{
  const mint = new PublicKey('CAA37EB8VnDD97MvDZKfHgChKbLNxD435WATp1Mgpump')
  ok('the bonding curve derives to the account these fixtures came from',
     bondingCurveAddress(mint).toBase58() === fx.accounts['curve-usdc-live'].address,
     bondingCurveAddress(mint).toBase58())
  ok('a different pool index is a different address, so one miss is not "no pool"',
     poolAddress(mint, mint, 0).toBase58() !== poolAddress(mint, mint, 1).toBase58())
}

console.log('\n── what a bad account does ──')
{
  let threw = false
  try { decodeBondingCurve(Buffer.alloc(20)) } catch { threw = true }
  ok('a too-short curve throws rather than decoding garbage', threw)
  threw = false
  try { decodePool(bytes('curve-usdc-live')) } catch { threw = true }
  ok('a curve handed to the pool decoder throws', threw)
  ok('a null account is not a zero balance', (() => {
    try { tokenAccountAmount(null); return false } catch { return true }
  })())
}

console.log('\n── every batched account read, across the whole project ──')
{
  /**
   * 🔴 The bug this guards: a `getMultipleAccounts` written with the protocol's limit of 100.
   * publicnode refuses anything above ten, and the failure only appears once there are enough of
   * something — ten sales in the listing, ten buyers in a delivery, ten positions in a portfolio.
   * Three separate files had it, found one at a time. This reads the source rather than trusting
   * that the fourth will be noticed.
   */
  const { RPC_BATCH } = await import('./program.mjs')
  ok(`the shared cap is ${RPC_BATCH}, at or below what the endpoint allows`, RPC_BATCH <= 10, String(RPC_BATCH))
  const files = [
    'program.mjs', 'watcher/attester.mjs', 'indexer/indexer.mjs',
    'web/src/Portfolio.jsx', 'web/src/Explore.jsx', 'web/src/Sale.jsx',
  ]
  const offenders = []
  for (const f of files) {
    const src = readFileSync(new URL(`./${f}`, import.meta.url), 'utf8')
    // A literal chunk size above the cap, in any `i += N` / `slice(i, i + N)` batching loop.
    for (const m of src.matchAll(/(?:i \+= |i \+ )(\d+)\b/g)) {
      if (Number(m[1]) > RPC_BATCH) offenders.push(`${f}: ${m[0]}`)
    }
  }
  ok('no file batches above it', offenders.length === 0, offenders.join(' · '))
}

{
  console.log('\n── a market cap is priced in the CURVE\'s unit, never the buyer\'s ──')
  /**
   * ⛔⛔ `quoteLabel` is what buyers PAY IN — 'usdc'. The coin's curve is the SOL curve. Passing
   * the pay unit into a market-cap call prices a 32-SOL curve at 223,049, and the page shows it
   * beside a chart whose own points are right, so the two disagree in plain sight.
   *
   * Found on the sale page 20 Sep, in both the chart's headline figure and the launched-coin line
   * under it, on the live site. The arithmetic was never wrong; the DENOMINATION was, which is the
   * third time that has happened in this codebase. So this reads the source: no market-cap call
   * may take a pay-unit variable, and none may be labelled with one.
   */
  const files = ['web/src/Sale.jsx', 'web/src/Explore.jsx', 'web/src/Chart.jsx', 'web/src/App.jsx']
  const bad = []
  for (const f of files) {
    const src = readFileSync(new URL(`./${f}`, import.meta.url), 'utf8')
    // Every market-cap call must name its denomination as the literal 'sol' — or, inside the
    // chart, as its own `curveQuote` prop, which is the same thing passed down by its caller.
    for (const m of src.matchAll(/\bmarketCap(?:FromSold)?\(/g)) {
      let i = m.index + m[0].length, depth = 1, last = i
      for (; i < src.length && depth > 0; i++) {
        const c = src[i]
        if (c === '(') depth++
        else if (c === ')') depth--
        else if (c === ',' && depth === 1) last = i + 1
      }
      const unit = src.slice(last, i - 1).trim()
      if (unit !== "'sol'" && unit !== 'curveQuote') bad.push(`${f}: ${m[0]}…${unit})`)
    }
    // A cap figure labelled with the pay unit.
    for (const m of src.matchAll(/[Mm]arket cap[^<]*<strong[^>]*>\{[^}]*[Mm]arketCap[^}]*\}\s*\{q\.label\}/g)) bad.push(`${f}: ${m[0]}`)
  }
  ok('no market cap is computed or labelled from the pay unit', bad.length === 0, bad.join(' · '))
}

{
  console.log('\n── our market cap IS pump.fun\'s, on real coins ──')
  /**
   * ⭐⭐ The whole claim in one test: a coin launched from here becomes a pump.fun coin, so the
   * figure on our pages must be the figure on theirs. The fixture holds coins that were live on
   * pump.fun when it was captured, with the caps THEIR API reported.
   *
   * ⚠ SOL is checked to six significant figures — the two arithmetics are the same one, so any
   * drift is a bug. Dollars carry 1.5%, because their snapshots price each coin a few seconds
   * apart and the SOL price moves between them; the tolerance is on THEIR staleness, not ours.
   */
  const { coins } = JSON.parse(readFileSync(new URL('./fixtures/pumpfun-market-caps.json', import.meta.url), 'utf8'))
  const { marketCapFromReserves, usdMarketCap, fmtUsdCap, solUsdFromReserves } = await import('./curve.mjs')
  ok(`the fixture holds ${coins.length} real coins`, coins.length >= 5)

  const ours = (c) => marketCapFromReserves(c.virtualSolReserves, c.virtualTokenReserves, 'sol')
  const solOff = coins.map((c) => Math.abs(ours(c) - c.marketCapSol) / c.marketCapSol)
  ok('every SOL market cap matches pump.fun\'s own figure', Math.max(...solOff) < 1e-6,
     coins.map((c) => `${c.symbol} ${ours(c)} vs ${c.marketCapSol}`).join(' · '))

  /**
   * ⛔ And the one-reserve form does NOT, which is why `marketCapFromCurve` reads both. Two of
   * these six coins sit on curves that did not open at this module's constants.
   */
  const { marketCap } = await import('./curve.mjs')
  const strayed = coins.filter((c) => Math.abs(marketCap(c.virtualSolReserves, 'sol') - c.marketCapSol) / c.marketCapSol > 1e-6)
  ok(`${strayed.length} of ${coins.length} would be mispriced from the SOL reserve alone`, strayed.length > 0,
     'if this ever reads 0 the fixture has lost the coins it was captured for')

  // The price pump.fun converted at, taken from the coins themselves: usd / sol, averaged.
  const rates = coins.map((c) => c.usdMarketCap / c.marketCapSol)
  const rate = rates.reduce((a, b) => a + b, 0) / rates.length
  const usdOff = coins.map((c) => Math.abs(usdMarketCap(ours(c), rate) - c.usdMarketCap) / c.usdMarketCap)
  ok('and every dollar figure lands within 1.5% of theirs', Math.max(...usdOff) < 0.015,
     `worst ${(Math.max(...usdOff) * 100).toFixed(2)}%`)

  // The pool the program swaps through is where that price comes from on the live site.
  ok('the pool reserves give a SOL price the same way', Math.abs(solUsdFromReserves(1_000_000_000n, 110_000_000n) - 110) < 1e-9)
  ok('no price means no dollar figure, never a guessed one', usdMarketCap(27.96, null) === null && usdMarketCap(27.96, 0) === null)

  // ⛔ pump.fun's own shorthand. A brand new coin sits under $10K, so the K form has to carry a
  // decimal or every new launch reads as the same "$3K".
  const shown = [[3082.67, '$3.1K'], [45_235, '$45.2K'], [1_234_567, '$1.2M'], [928.4, '$928'], [0, '$0']]
  ok('written the way pump.fun writes it', shown.every(([n, want]) => fmtUsdCap(n) === want),
     shown.map(([n]) => `${n} -> ${fmtUsdCap(n)}`).join(' · '))
  ok('and an unpriceable coin is a dash, not a dollar sign', fmtUsdCap(null) === '—' && fmtUsdCap(NaN) === '—')
}

{
  console.log('\n── an internal link is never sealed inside a stopPropagation box ──')
  /**
   * ⛔⛔ `interceptLinks()` listens on `document`. A container that answers clicks with
   * `stopPropagation()` therefore hides every `<a href="/…">` inside it from the router, and those
   * links quietly become FULL PAGE LOADS. The app remounts, and the wallet — which lives in a hook
   * — comes back empty.
   *
   * That is not theoretical: the wallet dropdown did exactly this. Opening `My tokens` from your
   * own wallet menu disconnected you, on the live site, and the page it landed on then told you to
   * connect a wallet. Nothing threw, nothing logged, and the link went to the right URL.
   *
   * So the rule is about the SHAPE, not the two links that were wrong: a component may stop click
   * propagation, and a component may hold internal links, but not both.
   *
   * ⚠ Scoped per COMPONENT and read with comments stripped. File-level, it flags a modal in one
   * component for a link in another; comments included, it flags the paragraph above for quoting
   * the very call it forbids — both happened while writing this.
   */
  const files = ['web/src/App.jsx', 'web/src/BuyWithFomo.jsx', 'web/src/Sale.jsx',
                 'web/src/Explore.jsx', 'web/src/Portfolio.jsx', 'web/src/MyTokens.jsx',
                 'web/src/Create.jsx', 'web/src/Chart.jsx']
  const uncomment = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const sealed = []
  for (const f of files) {
    const src = uncomment(readFileSync(new URL(`./${f}`, import.meta.url), 'utf8'))
    // Each top-level `function Name(` starts a component; the chunk runs to the next one.
    const heads = [...src.matchAll(/^(?:export default )?function (\w+)\(/gm)]
    for (const [i, h] of heads.entries()) {
      const chunk = src.slice(h.index, heads[i + 1]?.index ?? src.length)
      if (!/onClick=\{[^}]*stopPropagation\(\)/.test(chunk)) continue
      for (const m of chunk.matchAll(/href="(\/(?!\/)[^"]*)"/g)) {
        if (!/^\/(api|logos|assets)\//.test(m[1])) sealed.push(`${f} ${h[1]}(): ${m[1]}`)
      }
    }
  }
  ok('no component both swallows clicks and carries an internal link', sealed.length === 0, sealed.join(' · '))

  // The rule can only bite if the files it reads still hold the shapes it looks for.
  const app = uncomment(readFileSync(new URL('./web/src/App.jsx', import.meta.url), 'utf8'))
  ok('and App.jsx still carries internal links for it to find', /href="\/mytokens"/.test(app))
  const modal = uncomment(readFileSync(new URL('./web/src/BuyWithFomo.jsx', import.meta.url), 'utf8'))
  ok('while a link-free modal may still swallow', /stopPropagation\(\)/.test(modal))

  // And the wallet must survive the reload that a stray full navigation causes anyway.
  const wal = readFileSync(new URL('./web/src/wallet.js', import.meta.url), 'utf8')
  ok('the chosen wallet is remembered', /localStorage\.setItem\(REMEMBERED/.test(wal))
  ok('and restored without prompting', /connect\(\{ silent: true \}\)/.test(wal))
  ok('disconnect forgets it', /forget\(\)/.test(wal) && /localStorage\.removeItem\(REMEMBERED/.test(wal))
}

{
  console.log('\n── the curve decoder, against THREE live account shapes ──')
  /**
   * ⛔⛔ Pinned to bytes pump.fun wrote on 21 Sep 2026, because two separate assumptions in this
   * decoder were wrong at once and neither showed up as an error:
   *
   *  1. `quote_mint` was read as an `Option<Pubkey>` tagged by byte 82. Byte 82 is
   *     `is_cashback_coin`, which pump.fun deprecated to zero — so the tag was NEVER set and
   *     every quote-mint coin decoded as SOL. Measured live: **5 of 5 wrong**. The unit is what
   *     every market cap on the site is denominated in, so this is a wrong NUMBER, not a crash.
   *  2. The decoder required 81 bytes. A **49-byte** curve is a real, complete, tradeable coin
   *     whose account predates the struct growing, and it THREW — inside the market sweep, where
   *     the catch leaves the row's price untouched rather than reporting anything.
   */
  const shapes = [
    ['curve-sol-live-2026-09-21', 'a current SOL coin'],
    ['curve-quotemint-live-2026-09-21', 'a current quote-mint coin'],
    ['curve-short-migrated-2026-09-21', 'a 49-byte migrated coin'],
  ]
  for (const [key, what] of shapes) {
    const a = fx.accounts[key]
    ok(`the fixture holds ${what} (${a?.bytes} bytes)`, !!a && a.bytes > 0, key)
  }
  const sol = decodeBondingCurve(Buffer.from(fx.accounts['curve-sol-live-2026-09-21'].data, 'base64'))
  ok('a SOL coin reports NO quote mint, so it prices in SOL', sol.quoteMint === null, String(sol.quoteMint))

  const qm = decodeBondingCurve(Buffer.from(fx.accounts['curve-quotemint-live-2026-09-21'].data, 'base64'))
  ok('a quote-mint coin reports its mint, from offset 83 as a PLAIN pubkey',
     qm.quoteMint !== null, String(qm.quoteMint))
  // ⛔ The exact failure that shipped: byte 82 is zero on this very account, so an Option-tagged
  // read returns null and the coin is priced in the wrong asset.
  const raw = Buffer.from(fx.accounts['curve-quotemint-live-2026-09-21'].data, 'base64')
  ok('and byte 82 on it is ZERO — which is why the old Option read failed', raw[82] === 0, String(raw[82]))

  const short = Buffer.from(fx.accounts['curve-short-migrated-2026-09-21'].data, 'base64')
  ok('a 49-byte curve decodes instead of throwing', (() => {
    try { return decodeBondingCurve(short).complete === true } catch { return false }
  })(), `${short.length} bytes`)
  const sh = decodeBondingCurve(short)
  ok('it reads as complete, with a drained curve', sh.complete === true && sh.realToken === 0n)
  ok('and the fields it is too short to hold are null, never a zero pubkey',
     sh.creator === null && sh.quoteMint === null)

  // ⭐ The all-zero quote mint is SOL, and must not come back as a truthy zero pubkey.
  const zeroed = Buffer.from(fx.accounts['curve-sol-live-2026-09-21'].data, 'base64')
  ok('the SOL coin really does store all zeroes at 83..115',
     zeroed.subarray(83, 115).every((b) => b === 0))
}

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail ? 1 : 0)
