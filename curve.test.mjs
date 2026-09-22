import { ShadowCurve, tokensOut, solCost, feeOn, splitDeposit, totalWithFees, applyFee, VS0, VT0, RT0, FEE_PROTOCOL_BPS, FEE_CREATOR_BPS, MIN_DEPOSIT, MIN_DEPOSIT_FOR, MAX_WALLET_ALLOCATION, SUPPLY, walletHeadroom, marketCap, marketCapFromSold, openMarketCap, graduationMarketCap, unitOf, VQ0_USDC } from './curve.mjs'

let pass = 0, fail = 0
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log('  ✅', name) }
  else { fail++; console.log('  ❌', name, detail) }
}
const SOL = (n) => BigInt(Math.round(n * 1e9))
const USDC = (n) => BigInt(Math.round(n * 1e6))   // ⚠ six decimals, not nine

// Deterministic PRNG so a failure is reproducible.
let seed = 42
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648

console.log('\n── the separate-ceiling fee bug (the one the naive closed form has) ──')
{
  // The naive split: one combined 100bp ceiling.
  const naive = (gross) => (gross * 10_000n) / 10_125n
  let naiveFails = 0, properFails = 0, worst = 0n
  for (let i = 0; i < 200_000; i++) {
    const gross = BigInt(1_000_000 + i * 7919)
    const n = naive(gross)
    if (totalWithFees(n) > gross) { naiveFails++; const over = totalWithFees(n) - gross; if (over > worst) worst = over }
    const p = splitDeposit(gross).curveIn
    if (totalWithFees(p) > gross) properFails++
  }
  ok(`naive combined-ceiling split under-funds ${naiveFails} / 200000 deposits (by up to ${worst} lamports)`, naiveFails > 0)
  ok('walked-down split never under-funds', properFails === 0, `${properFails} failures`)
  ok('fee legs really are ceiled separately',
     applyFee(12345n, FEE_PROTOCOL_BPS) + applyFee(12345n, FEE_CREATOR_BPS) >= (12345n * 100n) / 10_000n)
}

console.log('\n── composability: the shadow curve IS the real curve ──')
{
  // Many sequential shadow buys must equal one aggregate buy, up to floor dust.
  for (const n of [2, 10, 100, 1000]) {
    const c = new ShadowCurve()
    for (let i = 0; i < n; i++) c.deposit('w' + i, SOL(0.01 + rnd() * 0.05))
    const oneShot = tokensOut(VS0, VT0, c.curveIn)
    const dust = oneShot - c.sold
    ok(`${n} deposits == 1 aggregate buy (dust ${dust} base units, ${(Number(dust) / 1e6).toFixed(9)} tokens)`,
       dust >= 0n && dust < BigInt(n) + 2n, `sum=${c.sold} oneShot=${oneShot}`)
  }
}

console.log('\n── THE critical invariant: the vault can always pay ──')
{
  for (const n of [1, 5, 50, 500, 2000]) {
    const c = new ShadowCurve()
    for (let i = 0; i < n; i++) {
      const cap = c.remainingCapacityLamports()
      if (cap < SOL(0.001)) break
      let amt = SOL(0.005 + rnd() * 0.2)
      if (amt > cap) amt = cap
      try { c.deposit('w' + i, amt) } catch { break }
    }
    const o = c.launchOrder()
    ok(`n=${String(n).padEnd(4)} slack=${o.slack} lamports (never negative)`, o.slack >= 0n,
       `required=${o.totalRequired} collected=${o.collected}`)
  }
}

console.log('\n── sum of allocations == tokens the buy actually delivers ──')
{
  const c = new ShadowCurve()
  for (let i = 0; i < 300; i++) c.deposit('w' + i, SOL(0.01 + rnd() * 0.1))
  const total = [...c.allocations.values()].reduce((a, b) => a + b, 0n)
  ok('every allocated base unit is covered', total === c.sold, `${total} vs ${c.sold}`)
  ok('nobody got zero', [...c.allocations.values()].every((v) => v > 0n))
}

console.log('\n── the curve cap holds ──')
{
  const c = new ShadowCurve()
  let n = 0
  while (c.remainingCapacityLamports() > SOL(0.01) && n < 20000) {
    try { c.deposit('w' + n++, SOL(0.5)) } catch { break }
  }
  ok(`filled with ${n} deposits, sold=${c.sold} <= RT0=${RT0}`, c.sold <= RT0)
  ok('cannot oversell', (() => { try { c.deposit('over', SOL(50)); return false } catch { return true } })())
  const o = c.launchOrder()
  console.log(`     full raise: ${(Number(o.collected) / 1e9).toFixed(3)} SOL for ${(Number(c.sold) / 1e6).toLocaleString()} tokens`)
  ok('full-curve slack still non-negative', o.slack >= 0n, `slack=${o.slack}`)
}

console.log('\n── price is monotonic: later money never gets a better deal ──')
{
  const c = new ShadowCurve()
  let prev = 0
  let monotonic = true
  for (let i = 0; i < 200; i++) {
    const amt = SOL(0.05)
    const out = c.deposit('w' + i, amt)
    const price = Number(amt) / Number(out)
    if (price < prev) monotonic = false
    prev = price
  }
  ok('each successive depositor pays >= the last', monotonic)
}

console.log('\n── the gap the presale was supposed to fix ──')
{
  for (const raise of [10, 42.5, 85]) {
    const c = new ShadowCurve()
    const per = SOL(raise / 200)
    for (let i = 0; i < 200; i++) { try { c.deposit('w' + i, per) } catch { break } }
    const first = Number(c.allocations.get('w0'))
    const last = Number([...c.allocations.values()].at(-1))
    const mkt = Number(c.vs) / Number(c.vt)
    const lastPrice = Number(per) / last
    console.log(`     raise ${String(raise).padEnd(5)} SOL: first buyer ${(first / 1e6).toLocaleString()} tok, ` +
      `last ${(last / 1e6).toLocaleString()} tok  ->  last buyer's gap at open = ${(mkt / lastPrice).toFixed(3)}x`)
    ok(`raise ${raise}: last depositor's entry is within 1% of the open price`, mkt / lastPrice < 1.01)
  }
}

console.log('\n── the protocol rules: a 0.01 SOL floor and a 3% of supply ceiling ──')
{
  const threw = (fn) => { try { fn(); return null } catch (e) { return e.message } }

  ok('a deposit one lamport under the floor is refused',
     threw(() => new ShadowCurve().deposit('w', MIN_DEPOSIT - 1n)) !== null)
  ok('a deposit exactly at the floor is accepted',
     threw(() => new ShadowCurve().deposit('w', MIN_DEPOSIT)) === null)
  ok('the ceiling is 3% of supply', MAX_WALLET_ALLOCATION === SUPPLY * 3n / 100n)

  // The headroom the UI offers must be exactly what the curve accepts — offering a lamport too
  // much would hand the depositor a transaction that reverts after they signed it.
  {
    const c = new ShadowCurve()
    const room = c.walletHeadroomLamports('whale')
    ok(`headroom at the open is ${(Number(room) / 1e9).toFixed(4)} SOL`, room > SOL(0.85) && room < SOL(0.9))
    ok('depositing exactly the headroom is accepted', threw(() => c.deposit('whale', room)) === null)
    ok('the resulting allocation is at or under the ceiling', c.allocations.get('whale') <= MAX_WALLET_ALLOCATION)
    ok('and one more minimum deposit is then refused',
       threw(() => c.deposit('whale', MIN_DEPOSIT)) !== null)
  }

  // ⛔ The two rules can disagree, and headroom is where they meet. A wallet just short of 3% has
  // room for fewer tokens than the floor buys: the ceiling permits a deposit the floor forbids.
  // Quoting that figure is the exact failure this module exists to prevent — a number the UI
  // offers and the program then rejects, after the depositor signed and paid a fee. It must
  // answer 0, and 0 must be the truth.
  {
    const c = new ShadowCurve()
    c.deposit('nearly', c.walletHeadroomLamports('nearly'))   // take the whole 3%, minus rounding
    const room = c.walletHeadroomLamports('nearly')
    ok('a wallet at the ceiling is quoted no headroom', room === 0n, `quoted ${room}`)

    // And the same on the way in: walk a wallet to just under the ceiling and check every quote.
    const d = new ShadowCurve()
    let quotes = 0, wedged = 0
    for (let i = 0; i < 60; i++) {
      const q = d.walletHeadroomLamports('w')
      quotes++
      if (q === 0n) { wedged++; break }
      // Every non-zero quote must be legally depositable on its own terms.
      if (q < MIN_DEPOSIT) { ok('every quoted headroom clears the floor', false, `quoted ${q}`); break }
      d.deposit('w', q < SOL(0.05) ? q : SOL(0.05))
    }
    ok(`every one of ${quotes} headroom quotes was either 0 or above the floor`, true)
    ok('and the walk ended wedged against the ceiling rather than quoting an illegal figure',
       wedged === 1)
  }

  // The headroom shrinks in SOL terms as the queue advances only because tokens get dearer; the
  // ALLOCATION it buys is the same 3% either way. This is the property a SOL cap cannot express.
  {
    const c = new ShadowCurve()
    const atOpen = c.walletHeadroomLamports('late')
    for (let i = 0; i < 40; i++) c.deposit('filler' + i, SOL(0.5))
    const later = c.walletHeadroomLamports('late')
    ok(`the same 3% costs ${(Number(atOpen) / 1e9).toFixed(3)} SOL at the open and ` +
       `${(Number(later) / 1e9).toFixed(3)} SOL after 20 SOL of queue`, later > atOpen * 2n)
  }

  // Splitting across wallets still works — the ceiling raises the cost of doing it, it does not
  // prevent it. Asserted so nobody reads the cap as an identity guarantee.
  {
    const c = new ShadowCurve()
    let total = 0n
    for (let i = 0; i < 3; i++) {
      const room = c.walletHeadroomLamports('sybil' + i)
      c.deposit('sybil' + i, room)
      total += c.allocations.get('sybil' + i)
    }
    ok(`three wallets take ${(Number(total * 10000n / SUPPLY) / 100).toFixed(2)}% of supply between them ` +
       '— the ceiling is per wallet, not per person', total > MAX_WALLET_ALLOCATION * 2n)
  }
}

console.log('\n── the max buy, walked up both curves ──')
{
  /*
   * ⛔ The 3% ceiling is in TOKENS, so the SAME percentage costs more and more quote as the curve
   * scales up. What the UI shows as "the most this wallet can add" therefore has to be recomputed
   * from the live reserves at every point — and it has to be right in the sale's own units.
   *
   * Two things are asserted at each step, because they are the two ways this has actually broken:
   *   1. the quote is EXACT — it buys at most the ceiling, and one base unit more would exceed it;
   *   2. the quote is LEGAL — it is either 0 or at or above THIS denomination's floor.
   */
  for (const quote of ['sol', 'usdc']) {
    const open = quote === 'usdc' ? VQ0_USDC : VS0
    const floor = MIN_DEPOSIT_FOR[quote]
    const c = new ShadowCurve(open)
    let steps = 0, checked = 0

    // Walk the curve up by depositing from a wallet that is NOT the one being quoted, so the
    // price moves while the quoted wallet's holding stays at zero.
    for (let i = 0; i < 40; i++) {
      const room = walletHeadroom(c.vs, c.vt, c.sold, 0n, FEE_PROTOCOL_BPS, FEE_CREATOR_BPS, quote)
      if (room === null) break              // the curve runs out before the ceiling does
      checked++

      // 1. exact against the ceiling
      const got = tokensOut(c.vs, c.vt, splitDeposit(room, FEE_PROTOCOL_BPS, FEE_CREATOR_BPS).curveIn, RT0 - c.sold)
      if (got > MAX_WALLET_ALLOCATION) {
        ok(`${quote}: step ${i} quote of ${room} buys ${got} > ceiling`, false); break
      }
      // 2. legal against the floor
      if (room !== 0n && room < floor) {
        ok(`${quote}: step ${i} quoted ${room}, below the ${floor} floor`, false); break
      }
      steps++
      const bump = quote === 'usdc' ? USDC(100) : SOL(0.8)
      if (c.sold + tokensOut(c.vs, c.vt, splitDeposit(bump, FEE_PROTOCOL_BPS, FEE_CREATOR_BPS).curveIn, RT0 - c.sold) > RT0) break
      c.deposit('mover' + i, bump)
    }
    ok(`${quote}: the max buy is exact and legal at all ${checked} points walked up the curve`,
       steps === checked && checked > 3, `${steps}/${checked}`)
  }

  // ⭐ The cost of the SAME 3% rises as the queue fills — the property the ceiling exists for. If
  // this ever stopped holding, a late depositor could take the ceiling as cheaply as an early one.
  for (const quote of ['sol', 'usdc']) {
    const open = quote === 'usdc' ? VQ0_USDC : VS0
    const c = new ShadowCurve(open)
    const atOpen = walletHeadroom(c.vs, c.vt, c.sold, 0n, FEE_PROTOCOL_BPS, FEE_CREATOR_BPS, quote)
    // ⚠ Several wallets, because ONE cannot move the curve far: the 3% ceiling is exactly the
    // rule that stops a single depositor filling the queue.
    for (let i = 0; i < 18; i++) c.deposit('mover' + i, quote === 'usdc' ? USDC(100) : SOL(0.8))
    const later = walletHeadroom(c.vs, c.vt, c.sold, 0n, FEE_PROTOCOL_BPS, FEE_CREATOR_BPS, quote)
    ok(`${quote}: 3% costs more once the queue has filled (${atOpen} -> ${later})`, later > atOpen)
  }

  // ⛔ The regression this fix is for: on a USDC sale the floor is 2 USDC, not the lamport
  // constant read as 10. A wallet with room worth between the two must be quoted a real figure.
  {
    const c = new ShadowCurve(VQ0_USDC)
    // Walk one wallet up to just under the ceiling, then check every quote it is given.
    let held = 0n, sawSmall = false
    for (let i = 0; i < 60 && held < MAX_WALLET_ALLOCATION; i++) {
      const room = walletHeadroom(c.vs, c.vt, c.sold, held, FEE_PROTOCOL_BPS, FEE_CREATOR_BPS, 'usdc')
      if (room === null) break
      if (room === 0n) break
      if (room < MIN_DEPOSIT_FOR.sol) sawSmall = true     // between the USDC floor and the SOL one
      ok(`usdc: a quote of ${room} is at or above the 2 USDC floor`, room >= MIN_DEPOSIT_FOR.usdc)
      const step = room > USDC(40) ? USDC(40) : room
      c.deposit('w', step)
      held = c.allocations.get('w')
      if (step === room) break
    }
    ok('usdc: quotes below the old lamport floor are now offered rather than suppressed', sawSmall,
       'no quote landed between 2 and 10 USDC, so this run did not exercise the fix')
  }
}

console.log('\n── market cap, in each denomination ──')
{
  // ⛔ The figure a depositor reads. It depends on the denomination in TWO places — the curve's
  // `k`, and the trailing SUPPLY / 10^quoteDecimals factor — and catching only the first reports
  // a 4 USDC market cap where the truth is 4,000. Pinned here because these four numbers are the
  // whole of what the chart, the listing and the create form display.
  ok(`a SOL curve opens at ${openMarketCap('sol').toFixed(2)} SOL`,
     Math.abs(openMarketCap('sol') - 27.96) < 0.01, `${openMarketCap('sol')}`)
  ok(`and graduates at ${graduationMarketCap('sol').toFixed(1)} SOL`,
     Math.abs(graduationMarketCap('sol') - 410.9) < 0.1, `${graduationMarketCap('sol')}`)
  ok(`a USDC curve opens at ${openMarketCap('usdc').toFixed(2)} USDC`,
     Math.abs(openMarketCap('usdc') - 4000) < 1, `${openMarketCap('usdc')}`)
  ok(`and graduates at ${graduationMarketCap('usdc').toFixed(0)} USDC`,
     Math.abs(graduationMarketCap('usdc') - 58783) < 10, `${graduationMarketCap('usdc')}`)

  // The two must not be the same number. If a denomination is ever dropped on the floor again,
  // this is what says so — the failure mode is a plausible-looking figure, not an error.
  ok('the two denominations do not produce the same market cap',
     openMarketCap('sol') !== openMarketCap('usdc'))

  // An unknown quote falls back to SOL rather than to NaN: a listing row written before the
  // column existed has no label, and it is a SOL sale.
  ok('an unknown quote reads as SOL', openMarketCap(undefined) === openMarketCap('sol'))
  ok('and so does its unit', unitOf(undefined) === 'SOL' && unitOf('usdc') === 'USDC')

  // `marketCapFromSold` is what the listing uses — it has `sold` but not the reserves. It must
  // agree with the reserve-based figure, in both denominations.
  for (const quote of ['sol', 'usdc']) {
    const c = new ShadowCurve(quote === 'usdc' ? VQ0_USDC : VS0)
    c.deposit('a', MIN_DEPOSIT_FOR[quote] * 40n)
    const fromReserves = marketCap(c.vs, quote)
    const fromSold = marketCapFromSold(c.sold, quote)
    ok(`${quote}: market cap from sold matches market cap from the reserves`,
       Math.abs(fromReserves - fromSold) / fromReserves < 1e-9,
       `${fromReserves} vs ${fromSold}`)
  }
}

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail ? 1 : 0)
