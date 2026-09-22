/**
 * What a Pump Family coin is worth, by phase — and the three different places that answer lives.
 *
 * A coin here passes through three states, and **each one is priced by a different account**. Using
 * the wrong one does not error; it returns a confident, plausible, wrong number:
 *
 *  1. **In the window.** No coin exists. The price is the shadow curve's, derived from `sold` —
 *     `marketCapFromSold` in `curve.mjs`.
 *  2. **Launched, still on the bonding curve.** pump.fun's `BondingCurve` account holds the live
 *     reserves, and its `virtual_quote` is what the cap is read from.
 *  3. **Migrated.** The curve is drained into a pump AMM pool and **reads ALL ZEROES** — measured
 *     on a real migrated coin: `virtual_token 0, virtual_quote 0, real_token 0, real_quote 0,
 *     complete 1`. So a cap taken from the curve after migration is exactly **0**, and a listing
 *     that does it shows a graduated coin as worthless. The price then lives in the pool's two
 *     token accounts.
 *
 * ⛔ `complete == 1` is the only reliable marker of migration, and it is sticky: pump.fun sets it
 * when the curve is bought out and nothing clears it.
 *
 * ⛔ **Never price a migrated coin from its curve, and never show a zero when the pool could not be
 * read.** Unreadable is not the same as worthless, and the difference is the whole point of
 * `marketOf` returning `null` rather than 0.
 *
 * Every address derivation and every offset below was read off mainnet on 18 Sep 2026, not from
 * documentation:
 *
 *  - `BondingCurve` = PDA `["bonding-curve", mint]` under pump.fun, 115 bytes.
 *  - The migrated pool = PDA `["pool", u16 index, PDA["pool-authority", mint], base, quote]` under
 *    the pump AMM — derived, so no `getProgramAccounts` is needed to find it.
 *  - Pool reserves are the balances of the two token accounts the pool names, NOT fields on it.
 */
import { PublicKey } from '@solana/web3.js'
import { SUPPLY, marketCap, marketCapFromReserves } from './curve.mjs'

/** pump.fun's bonding-curve program. */
export const PUMP = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P')
/** pump.fun's AMM — where a coin trades once it has migrated off the curve. */
export const PUMP_AMM = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA')

const pda = (seeds, program) => PublicKey.findProgramAddressSync(seeds, program)[0]
const u16le = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b }

export const bondingCurveAddress = (mint) => pda([Buffer.from('bonding-curve'), mint.toBuffer()], PUMP)

/** The account pump.fun creates the migrated pool as. Also the pool PDA's `creator` seed. */
export const poolAuthority = (mint) => pda([Buffer.from('pool-authority'), mint.toBuffer()], PUMP)

/**
 * The pool a migrated coin trades in.
 *
 * ⚠ `index` is part of the seed. Every migration observed uses 0, but a pool at another index is
 * indistinguishable from no pool at all if only 0 is tried — so callers walk a few (`POOL_INDEXES`)
 * rather than concluding "no pool" from one miss.
 */
export const poolAddress = (mint, quoteMint, index = 0) =>
  pda([Buffer.from('pool'), u16le(index), poolAuthority(mint).toBuffer(), mint.toBuffer(), quoteMint.toBuffer()],
      PUMP_AMM)

export const POOL_INDEXES = [0, 1, 2, 3]

/**
 * pump.fun's `BondingCurve`. Read off the live IDL, 21 Sep 2026.
 *
 * ⚠ `virtualQuote` is denominated in whatever the coin's quote is: lamports for a SOL launch, USDC
 * base units for a quote-mint launch. Six decimals against nine — reusing one for the other is out
 * by a factor of a thousand, which is the most repeated bug in this repo.
 *
 * ⛔⛔ **`quote_mint` is a PLAIN pubkey at offset 83, and "SOL" is written as all zeroes.** This
 * used to read it as an `Option<Pubkey>` tagged by byte 82 — but byte 82 is `is_cashback_coin`,
 * which pump.fun deprecated to zero, so the tag was never set and EVERY quote-mint coin decoded
 * as SOL. Measured against live mainnet curves: **5 of 5 quote-mint coins decoded wrong**, and
 * the unit is what every market cap on the site is denominated in.
 *
 * ⚠ Three account LENGTHS are live at once — 49, 125 and 151 bytes — because the struct has grown
 * and `extend_account` is what migrates an old one. A 49-byte curve is a real, complete, tradeable
 * coin, and this used to THROW on it.
 *
 * Layout: 8 disc · 5×u64 · complete@48 · creator@49 · is_mayhem@81 · is_cashback@82 ·
 * quote_mint@83 · creator_fee_bps@115 · can_edit_creator_fee@123 · is_holder_reward@124
 */
const ZERO_PUBKEY = new PublicKey(new Uint8Array(32))

export function decodeBondingCurve(data) {
  // 49 bytes is the shortest shape pump.fun still serves: through `complete` and no further.
  if (!data || data.length < 49) throw new Error(`not a bonding curve: ${data?.length ?? 0} bytes`)
  const u64 = (o) => data.readBigUInt64LE(o)
  const has = (end) => data.length >= end
  const quote = has(115) ? new PublicKey(data.subarray(83, 115)) : null
  return {
    virtualToken: u64(8),
    virtualQuote: u64(16),
    realToken: u64(24),
    realQuote: u64(32),
    totalSupply: u64(40),
    complete: data[48] === 1,
    creator: has(81) ? new PublicKey(data.subarray(49, 81)) : null,
    // ⛔ All zeroes means NATIVE SOL, and `null` here is what the rest of the code reads as SOL.
    // Returning the zero pubkey instead would be truthy and price every SOL coin in USDC.
    quoteMint: quote && !quote.equals(ZERO_PUBKEY) ? quote : null,
    // Only meaningful on the current layout; null on a curve too short to hold them.
    creatorFeeBps: has(123) ? u64(115) : null,
    isHolderReward: has(125) ? data[124] === 1 : null,
  }
}

/** The pump AMM's `Pool`. The reserves are NOT here — they are the balances of the two accounts. */
export function decodePool(data) {
  if (!data || data.length < 211) throw new Error(`not a pool: ${data?.length ?? 0} bytes`)
  const pk = (o) => new PublicKey(data.subarray(o, o + 32))
  return {
    index: data.readUInt16LE(9),
    creator: pk(11),
    baseMint: pk(43),
    quoteMint: pk(75),
    lpMint: pk(107),
    baseAccount: pk(139),
    quoteAccount: pk(171),
    lpSupply: data.readBigUInt64LE(203),
  }
}

/** An SPL / Token-2022 token account's balance. Both layouts carry it at the same offset. */
export function tokenAccountAmount(data) {
  if (!data || data.length < 72) throw new Error('not a token account')
  return data.readBigUInt64LE(64)
}

/** Every pump.fun coin is minted at six decimals, whatever its quote is. */
export const COIN_DECIMALS = 6
const QUOTE_DECIMALS = { sol: 9, usdc: 6 }

/**
 * Market cap from a live bonding curve, in the quote asset.
 *
 * ⛔ Refuses a completed curve rather than returning its zero. See the module note.
 */
export function marketCapFromCurve(curve, quote = 'usdc') {
  if (curve.complete) return null
  if (curve.virtualQuote === 0n || curve.virtualToken === 0n) return null
  // ⛔ BOTH reserves. Inferring the token side from our own constants prices a coin whose curve
  // opened elsewhere as much as a third under what pump.fun shows — see `marketCapFromReserves`.
  return marketCapFromReserves(curve.virtualQuote, curve.virtualToken, quote)
}

/**
 * Market cap from a migrated coin's pool, in the quote asset.
 *
 * Price is the pool's own ratio, and the cap is that price across the whole supply — the figure
 * every chart site shows. An empty side means the pool cannot price anything, which is `null`, not
 * zero.
 */
export function marketCapFromPool(baseReserve, quoteReserve, quote = 'usdc') {
  const base = Number(baseReserve), q = Number(quoteReserve)
  if (!(base > 0) || !(q > 0)) return null
  const qd = QUOTE_DECIMALS[quote] ?? QUOTE_DECIMALS.sol
  const price = (q / 10 ** qd) / (base / 10 ** COIN_DECIMALS)
  return price * (Number(SUPPLY) / 10 ** COIN_DECIMALS)
}
