/**
 * The Pump Family shadow curve.
 *
 * A presale deposit is priced as if it were a real pump.fun bonding-curve buy at that moment in
 * the queue: the first depositor gets the cheap tokens, later ones walk the price up. When the
 * window closes the vault performs ONE real `buy` for the summed token amount, and every depositor
 * claims exactly the allocation the shadow curve already promised them.
 *
 * This works because a constant-product curve composes: buying with r1 then r2 yields exactly the
 * same tokens as buying once with r1+r2. The shadow curve is therefore not an approximation of
 * the real one — it is the same curve, evaluated ahead of time.
 *
 * Everything is BigInt. Lamports (9dp) for SOL, base units (6dp) for tokens.
 */

/* Live pump.fun `Global`, read from mainnet 22 Aug 2026. */
export const VS0 = 30_000_000_000n            // initial_virtual_sol_reserves   = 30 SOL
export const VT0 = 1_073_000_000_000_000n     // initial_virtual_token_reserves
export const RT0 = 793_100_000_000_000n       // initial_real_token_reserves = 79.31% of supply
export const SUPPLY = 1_000_000_000_000_000n
/*
 * The two fees are SEPARATE and each is rounded up independently by the program. Treating them
 * as a single 100bp ceiling understates the total by up to two lamports per trade — enough to
 * make the vault's launch buy exceed `max_sol_cost` and revert. Ported from launchdeck's
 * `curve.ts`, which is validated against real mainnet buys.
 */
/* ⛔ NOT from `Global`. `Global.creator_fee_basis_points` reads 5, but `buy` calls the fee
 * program's `GetFees`, which returned (0, 95, 30) on mainnet — a real total of 125 bps. Budgeting
 * off `Global` under-funds every launch by 25 bps and the buy reverts on `TooMuchSolRequired`.
 * Measured against the live program. */
export const FEE_PROTOCOL_BPS = 95n
export const FEE_CREATOR_BPS = 30n

/*
 * Protocol rules, mirroring `MIN_DEPOSIT` and `MAX_WALLET_ALLOCATION` in the program. Kept here so
 * the browser refuses before the chain does — the chain is still the authority, this only saves a
 * depositor a failed transaction and a fee.
 *
 * The ceiling is denominated in TOKENS on purpose. A cap in SOL bounds what a wallet spends, not
 * what it receives, and the shadow curve makes those two very different quantities: the same
 * deposit buys several times more tokens at the open than at the close. See `cap_tests` in lib.rs.
 */
export const MIN_DEPOSIT = 10_000_000n             // 0.01 SOL — above the ATA rent to claim it

/** The quote reserve a USDC-denominated curve opens at. ⚠ 6 decimals, where SOL has 9. */
export const VQ0_USDC = 4_292_000_000n

/**
 * The floor, per denomination, in that quote's own base units.
 *
 * ⚠ A single floor compared against a raw amount is one number meaning two different things:
 * 0.01 SOL and 10 USDC are both `10_000_000`, and the second is a thousand times stricter than
 * anyone intended. Mirrors `Quote::min_deposit` in curve.rs.
 */
export const MIN_DEPOSIT_FOR = { sol: MIN_DEPOSIT, usdc: 2_000_000n }

/**
 * What an amount of the quote asset is worth in lamports, at a pool's spot.
 *
 * ⛔ The mirror of `sol_equivalent` in the program, and it has to stay a mirror: a buy is quoted
 * in the browser with this and booked on chain with that, and a disagreement shows up as a
 * depositor being told one number and credited another.
 *
 * Buyers pay USDC because that is what FOMO sends; the coin launches on pump.fun's SOL curve. This
 * is the conversion between the two, and the rate comes from the pool the raise will be swapped
 * through — never from a price feed nobody here controls.
 */
export function solEquivalent(amount, solReserve, usdcReserve) {
  const sol = BigInt(solReserve), usdc = BigInt(usdcReserve)
  if (sol <= 0n || usdc <= 0n) throw new Error('the swap pool cannot price anything right now')
  return (BigInt(amount) * sol) / usdc
}

/**
 * What a swap of `amountIn` USDC returns, by the constant product Raydium runs — fee included.
 * The same arithmetic `swap.rs` uses to set its own floor, so a quote shown to a creator and the
 * bound the program enforces cannot drift apart.
 */
export const POOL_FEE_BPS = 25n
export function poolQuoteOut(solReserve, usdcReserve, amountIn) {
  const sol = BigInt(solReserve), usdc = BigInt(usdcReserve)
  if (sol <= 0n || usdc <= 0n) return 0n
  const afterFee = (BigInt(amountIn) * (10_000n - POOL_FEE_BPS)) / 10_000n
  return sol - (sol * usdc) / (usdc + afterFee)
}
export const MAX_WALLET_BPS = 300n                 // 3% of supply
export const MAX_WALLET_ALLOCATION = SUPPLY * MAX_WALLET_BPS / 10_000n
const BPS = 10_000n

const ceilDiv = (a, b) => a / b + (a % b === 0n ? 0n : 1n)

/** One fee leg, rounded the way the program rounds it. */
export function applyFee(amount, bps) {
  return ceilDiv(amount * bps, BPS)
}

/** Curve price plus BOTH fees, each ceiled separately. */
export function totalWithFees(curveIn, protocolBps = FEE_PROTOCOL_BPS, creatorBps = FEE_CREATOR_BPS) {
  return curveIn + applyFee(curveIn, protocolBps) + applyFee(curveIn, creatorBps)
}

/**
 * Tokens received for `solIn` lamports against reserves (vs, vt).
 *
 * Derived from k = vs*vt: out = vt - k/(vs+solIn) = vt*solIn/(vs+solIn).
 * Floored — every rounding decision in this file must favour the vault, never the claimant,
 * or the last person to claim finds the vault empty.
 */
export function tokensOut(vs, vt, solIn, realTokenReserves = RT0) {
  if (solIn <= 0n) return 0n
  // Round the REMAINING reserve up, which rounds tokens handed out down. Flooring the reserve
  // instead inflates tokensOut above what the curve will really give, and pricing that inflated
  // figure back through solCost then exceeds the budget it came from.
  const newTokens = ceilDiv(vs * vt, vs + solIn)
  const out = vt - newTokens
  if (out <= 0n) return 0n
  return out > realTokenReserves ? realTokenReserves : out
}

/**
 * Lamports pump.fun will charge for `tokens`, before fees, from the pristine curve.
 * Ceiled, because the program rounds the cost in its own favour and we must not under-fund.
 */
export function solCost(tokens, vs = VS0, vt = VT0) {
  if (tokens <= 0n) return 0n
  if (tokens >= vt) throw new Error('cost: tokens exceed virtual reserves')
  return ceilDiv(vs * vt, vt - tokens) - vs
}

/** The 1% pump.fun takes on top of the curve cost — both legs, ceiled separately. */
export function feeOn(cost, protocolBps = FEE_PROTOCOL_BPS, creatorBps = FEE_CREATOR_BPS) {
  return applyFee(cost, protocolBps) + applyFee(cost, creatorBps)
}

/**
 * Splits a gross deposit into the part that buys curve and the part held back for the launch fee.
 *
 * Held back rather than charged later: the vault must still be able to pay pump.fun's 1% at
 * launch, and by then the depositor is gone.
 *
 * The closed form `gross * 10000 / 10100` OVERSHOOTS, because the two fee legs are ceiled
 * separately and their sum can exceed a combined ceiling by up to two lamports. So it is used
 * only as a starting point and walked down until the reconstructed total genuinely fits.
 */
export function splitDeposit(gross, protocolBps = FEE_PROTOCOL_BPS, creatorBps = FEE_CREATOR_BPS) {
  let curveIn = (gross * BPS) / (BPS + protocolBps + creatorBps)
  while (curveIn > 0n && totalWithFees(curveIn, protocolBps, creatorBps) > gross) curveIn -= 1n
  return { curveIn, feeHeld: gross - curveIn }
}

/**
 * The largest gross deposit a wallet may still make before the 3% ceiling stops it.
 *
 * Takes the curve's state directly rather than a ShadowCurve, so the browser can compute it from a
 * decoded sale account — replaying every deposit to answer this would need an event history the
 * front end does not have.
 *
 * Inverts the curve at the wallet's remaining token headroom rather than searching for it, then
 * walks the result down: `totalWithFees` ceils, which can put the gross a lamport past what those
 * tokens cost, and a figure the UI offers that the program then rejects is worse than no figure.
 *
 * Returns `null` when the ceiling does not bind before the curve's own capacity does — the caller
 * should fall back to `remainingCapacityLamports`.
 */
export function walletHeadroom(vs, vt, sold, held, protocolBps = FEE_PROTOCOL_BPS, creatorBps = FEE_CREATOR_BPS, quote = 'sol') {
  const room = MAX_WALLET_ALLOCATION - held
  if (room <= 0n) return 0n
  const left = RT0 - sold
  if (room >= left) return null
  let g = totalWithFees(ceilDiv(vs * vt, vt - room) - vs, protocolBps, creatorBps)
  while (g > 0n && tokensOut(vs, vt, splitDeposit(g, protocolBps, creatorBps).curveIn, left) > room) g -= 1n
  // Two rules bound a deposit, and a figure that satisfies only one of them is not headroom.
  // A wallet near the ceiling can have room for fewer tokens than the floor buys — the token
  // ceiling says yes, the floor says no — and quoting that figure would offer a deposit the
  // program rejects with DepositBelowMinimum, after the depositor has signed and paid a fee.
  // Zero is the truthful answer: nothing this wallet can legally deposit still fits.
  //
  // ⛔ PER DENOMINATION. The bare constant is lamports; against a 6-decimal quote it reads as a
  // 10 USDC floor where the real one is 2, so this returned 0 — "nothing fits" — for every wallet
  // whose remaining room was worth between 2 and 10 USDC, all of which are legal deposits. The
  // ceiling itself is in TOKENS and needs no denomination, which is exactly why the floor is easy
  // to miss here.
  if (g < (MIN_DEPOSIT_FOR[quote] ?? MIN_DEPOSIT)) return 0n
  return g
}

export class ShadowCurve {
  /**
   * `vs0` is the opening quote reserve: `VS0` for SOL, `VQ0_USDC` for a USDC sale.
   *
   * ⛔ `quote` is not cosmetic — it decides the FLOOR this curve enforces. Defaulted from the
   * reserve so an existing caller that passes only `VQ0_USDC` gets the USDC floor rather than a
   * lamport one: the mirror rejecting a deposit the program accepts is the same "one condition
   * checked where two govern" failure as quoting one the program rejects, just pointing the other
   * way. It surfaced as `walletHeadroom` correctly quoting 4.99 USDC and this refusing it as
   * "below the 0.01 SOL minimum".
   */
  constructor(vs0 = VS0, quote = (vs0 === VQ0_USDC ? 'usdc' : 'sol')) {
    this.quote = quote
    this.vs = vs0
    this.vt = VT0
    this.sold = 0n          // tokens allocated so far; hard-capped at RT0
    this.curveIn = 0n       // lamports destined for the curve
    this.feeHeld = 0n       // lamports held back to pay pump.fun's 1%
    this.allocations = new Map()
  }

  /** Lamports that would still fit before the curve is exhausted. 0 once full. */
  remainingCapacityLamports() {
    const left = RT0 - this.sold
    if (left <= 0n) return 0n
    // Invert out = vt*s/(vs+s)  ->  s = vs*out/(vt-out)
    const gross = ceilDiv(this.vs * this.vt, this.vt - left) - this.vs
    return totalWithFees(gross)
  }

  /**
   * Books a deposit and returns the allocation.
   * Rejects rather than clamps when the curve cannot absorb it — a partial fill would leave the
   * depositor with change the vault has no path to return.
   */
  deposit(wallet, gross) {
    const floor = MIN_DEPOSIT_FOR[this.quote] ?? MIN_DEPOSIT
    if (gross < floor) {
      const dec = this.quote === 'usdc' ? 1e6 : 1e9
      throw new Error(`deposit is below the ${Number(floor) / dec} ${unitOf(this.quote)} minimum`)
    }
    const { curveIn, feeHeld } = splitDeposit(gross)
    const out = tokensOut(this.vs, this.vt, curveIn, RT0 - this.sold)
    if (out <= 0n) throw new Error('deposit too small to allocate a single base unit')
    if (this.sold + out > RT0) throw new Error('exceeds curve capacity')
    const held = this.allocations.get(wallet) ?? 0n
    if (held + out > MAX_WALLET_ALLOCATION) {
      throw new Error('this wallet would hold more than 3% of supply')
    }

    this.vs += curveIn
    this.vt -= out
    this.sold += out
    this.curveIn += curveIn
    this.feeHeld += feeHeld
    this.allocations.set(wallet, (this.allocations.get(wallet) ?? 0n) + out)
    return out
  }

  /** @see walletHeadroom — this is the same calculation against the curve's own state. */
  walletHeadroomLamports(wallet) {
    // ⚠ Passes this curve's own denomination, or the answer is measured against a lamport floor
    // on a six-decimal quote — see the constructor.
    return walletHeadroom(this.vs, this.vt, this.sold, this.allocations.get(wallet) ?? 0n,
                          FEE_PROTOCOL_BPS, FEE_CREATOR_BPS, this.quote)
  }

  /** What the vault must execute at window close. */
  launchOrder() {
    const cost = solCost(this.sold)
    const fee = feeOn(cost)
    return {
      tokens: this.sold,
      curveCost: cost,
      fee,
      totalRequired: cost + fee,
      collected: this.curveIn + this.feeHeld,
      // Positive slack means the vault holds more than the buy needs. Must never be negative.
      slack: this.curveIn + this.feeHeld - (cost + fee),
    }
  }
}

/* ------------------------------------------------------------------ market cap
 *
 * A presale in progress already HAS a price, and market cap is how it is read: price per token at
 * the open is 2.8e-8, which nobody parses, while the same curve in market cap runs 27.96 SOL at
 * the open to 410.9 at graduation — the figure pump.fun and every chart site display.
 *
 *   mcap = vs/vt × SUPPLY / 10^quoteDecimals
 *        = vs² / (open · VT0) × SCALE      (since vs·vt is invariant and k = open · VT0)
 *
 * ⚠⚠ TWO things here depend on the denomination and it is easy to catch only one. `k` differs
 * because the curves open at different reserves (30 SOL against 4,292 USDC) — AND the trailing
 * factor is `SUPPLY / 10^quoteDecimals`, which is 1e6 for a nine-decimal quote and **1e9 for a
 * six-decimal one**. Carrying SOL's 1e6 into a USDC sale reports a 4 USDC market cap where the
 * truth is 4,000: wrong by a thousand, and small enough to read as a real number.
 *
 * This lives here rather than in the chart component so it is the same arithmetic everywhere and
 * so a test can hold it. `curve.test.mjs` pins all four figures.
 */
export const OPENING_RESERVE = { sol: VS0, usdc: VQ0_USDC }
export const MCAP_SCALE = { sol: 1e6, usdc: 1e9 }
export const reserveOf = (quote = 'sol') => OPENING_RESERVE[quote] ?? VS0
export const scaleOf = (quote = 'sol') => MCAP_SCALE[quote] ?? MCAP_SCALE.sol
export const unitOf = (quote = 'sol') => (quote === 'usdc' ? 'USDC' : 'SOL')

/** Market cap in the quote's own whole units, for a given virtual quote reserve. */
export function marketCap(virtualQuote, quote = 'sol') {
  const vs = Number(virtualQuote)
  const k = Number(reserveOf(quote) * VT0)
  return (vs * vs) / k * scaleOf(quote)
}

/**
 * The market cap as pump.fun states it: **US dollars**, not SOL.
 *
 * ## Why dollars, and why this is the same number pump.fun shows
 *
 * A coin launched from here IS a pump.fun coin the moment the window closes, so the figure on our
 * pages has to be the figure on theirs — a visitor comparing the two must not find two answers.
 * Measured against pump.fun's own API on 20 Sep 2026, on real live coins:
 *
 *  - our `marketCap(vs, 'sol')` equals their `market_cap` **exactly**, to every digit they print;
 *  - their `usd_market_cap / market_cap` came to 110.05 across eight coins, and the Raydium pool
 *    this program already swaps through read 110.0483 — a 0.002% difference.
 *
 * So dollars = SOL cap × the pool's spot, and `fixtures/pumpfun-market-caps.json` pins both halves
 * against coins that were live when it was captured.
 *
 * ⛔ `solUsd` comes from the SAME pool the program converts deposits at, not from a price API. A
 * second source would drift from what buyers are actually charged, and the two would disagree on
 * the same page.
 */
export const usdMarketCap = (capSol, solUsd) =>
  (typeof solUsd === 'number' && solUsd > 0 ? capSol * solUsd : null)

/**
 * A dollar figure written the way pump.fun writes it: `$3.1K`, `$65.4K`, `$1.2M`.
 *
 * ⚠ Under a thousand it stays whole — `$928`, not `$0.9K` — because that is the range a brand new
 * coin sits in and a rounded-to-nothing figure reads as broken.
 */
export function fmtUsdCap(usd) {
  if (typeof usd !== 'number' || !isFinite(usd)) return '—'
  const abs = Math.abs(usd)
  if (abs >= 1e9) return `$${(usd / 1e9).toFixed(1)}B`
  if (abs >= 1e6) return `$${(usd / 1e6).toFixed(1)}M`
  if (abs >= 1e3) return `$${(usd / 1e3).toFixed(1)}K`
  return `$${Math.round(usd)}`
}

/** The SOL price the pool is quoting: USDC per SOL, from the reserves the program itself reads. */
export const solUsdFromReserves = (solReserve, usdcReserve) => {
  const sol = Number(solReserve) / 1e9
  const usdc = Number(usdcReserve) / 1e6
  return sol > 0 ? usdc / sol : null
}

/**
 * Market cap from BOTH of a live curve's reserves — the only form that is right for a coin whose
 * curve did not start at our constants.
 *
 * ⛔⛔ `marketCap(vs)` above infers the token side from `k = open · VT0`, which holds only while a
 * curve keeps the initial reserves this module pins. Real pump.fun coins do not all: of six live
 * coins read from their API on 20 Sep 2026, two sat on curves with a different `k` (one opened
 * below 30 SOL), and pricing them from `vs` alone was **32% under** what pump.fun displayed.
 *
 * Reading both reserves needs no assumption at all: price = vs/vt, cap = price × supply. Use this
 * for any curve that came off the chain. `marketCap(vs)` remains right for OUR shadow curve, which
 * this module defines and therefore knows the constants of.
 */
export function marketCapFromReserves(virtualQuote, virtualToken, quote = 'sol') {
  const vq = Number(virtualQuote), vt = Number(virtualToken)
  if (!(vq > 0) || !(vt > 0)) return null
  const quoteDecimals = quote === 'usdc' ? 1e6 : 1e9
  const price = (vq / quoteDecimals) / (vt / 1e6)     // quote per token
  return price * (Number(SUPPLY) / 1e6)               // × every token that will ever exist
}

/** What the curve opens at, before any deposit. */
export const openMarketCap = (quote = 'sol') => marketCap(Number(reserveOf(quote)), quote)

/**
 * Market cap from `sold` alone — what the listing has.
 *
 * `vs·vt` is invariant, so `vt = VT0 - sold` and `vs = k / vt`. No extra column, and no second
 * definition of the price.
 */
export function marketCapFromSold(sold, quote = 'sol') {
  const k = reserveOf(quote) * VT0
  const vt = VT0 - BigInt(sold ?? 0)
  return marketCap(vt <= 0n ? Number(k) : Number(k) / Number(vt), quote)
}

/** Market cap once the curve is exhausted — the point pump.fun graduates a coin. */
export function graduationMarketCap(quote = 'sol') {
  const open = reserveOf(quote)
  // Inverting out = vt·s/(vs+s) at out = RT0 gives the quote that buys the whole curve.
  const toFill = (open * VT0) / (VT0 - RT0) - open
  return marketCap(Number(open + toFill), quote)
}
