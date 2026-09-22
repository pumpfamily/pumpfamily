//! The shadow curve.
//!
//! A presale deposit is priced as if it were a real pump.fun bonding-curve buy at that moment in
//! the queue. This works because a constant-product curve composes: buying with `r1` then `r2`
//! yields exactly the same tokens as buying once with `r1 + r2`. So the vault can book every
//! deposit ahead of time and settle them all with ONE real `buy` at launch.
//!
//! Every rounding decision here favours the vault. The claim path pays out of a fixed pot, so a
//! single base unit of over-allocation means the last claimant finds it empty.
//!
//! Mirrors `curve.mjs`, which is property-tested against the same vectors.

use anchor_lang::prelude::*;

use crate::PumpFamilyError;

/// Live pump.fun `Global`, read from mainnet 22 Aug 2026.
pub const VS0: u128 = 30_000_000_000; // initial_virtual_sol_reserves = 30 SOL

/// The quote reserve a USDC-denominated curve opens at.
///
/// pump.fun runs the SAME constant product for a quote-mint launch; only the quote side of the
/// reserves differs. Verified against a live USDC coin
/// (`CAA37EB8VnDD97MvDZKfHgChKbLNxD435WATp1Mgpump`): its `vt * vq` equals `VT0 * VQ0` to within
/// rounding, and the tokens that left the virtual reserve exactly equal the fall in the real one.
///
/// ⚠ **6 decimals, where SOL has 9.** Reusing a lamport figure here is out by a factor of 1000,
/// which is the single easiest way to get this wrong.
pub const VQ0_USDC: u128 = 4_292_000_000; // initial_virtual_quote_reserves = 4,292 USDC

/// USDC's mint. The only quote mint pump.fun whitelists today.
pub const USDC_MINT: Pubkey = pubkey!("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

/// What a sale is denominated in.
///
/// The token side of the curve is identical either way — same `VT0`, same `RT0` — so this only
/// decides the opening quote reserve and what a depositor actually sends.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum Quote {
    /// Native SOL, 9 decimals. The original path: `create` + `buy`.
    Sol,
    /// USDC, 6 decimals. Requires `create_v2` + `buy_v2`, and the coin is Token-2022.
    Usdc,
    /// USDC deposits, exactly like `Usdc` in every respect of the WINDOW — floor, decimals,
    /// refunds — but the coin launches paired with a pump.fun custom liquidity token. See
    /// `pair.rs`. Set by `set_pair`, and it is what makes `launch` refuse the sale: a sale that
    /// promised a pair token must never be launched SOL-paired by a permissionless cranker.
    UsdcPair,
}

impl Quote {
    pub fn from_u8(v: u8) -> Result<Self> {
        match v {
            0 => Ok(Quote::Sol),
            1 => Ok(Quote::Usdc),
            2 => Ok(Quote::UsdcPair),
            _ => Err(PumpFamilyError::UnknownQuote.into()),
        }
    }
    /// The reserve this curve opens at.
    pub fn initial_reserve(self) -> u128 {
        match self {
            Quote::Sol => VS0,
            Quote::Usdc | Quote::UsdcPair => VQ0_USDC,
        }
    }
    /// The smallest legal deposit, in this quote's OWN base units.
    ///
    /// ⚠ This has to be per-quote or it is nonsense. `MIN_DEPOSIT` is compared against a raw
    /// amount, so the 0.01 SOL floor read as a **10 USDC** floor on a 6-decimal quote — a
    /// thousand times stricter than intended, purely because the constant was written for
    /// lamports. The reason for the floor is unchanged: a position has to be worth more than the
    /// token-account rent it costs to collect.
    pub fn min_deposit(self) -> u64 {
        match self {
            Quote::Sol => crate::MIN_DEPOSIT,   // 0.01 SOL
            Quote::Usdc | Quote::UsdcPair => 2_000_000,       // 2 USDC, comfortably above the ~0.002 SOL of rent
        }
    }

    /// Decimals, for anything that has to print or convert.
    pub fn decimals(self) -> u8 {
        match self {
            Quote::Sol => 9,
            Quote::Usdc | Quote::UsdcPair => 6,
        }
    }
}
pub const VT0: u128 = 1_073_000_000_000_000; // initial_virtual_token_reserves
pub const RT0: u128 = 793_100_000_000_000; // initial_real_token_reserves = 79.31% of supply

/// ⛔ The fee rate is NOT `Global`. `Global.creator_fee_basis_points` reads 5, but `buy` calls out
/// to the fee program's `GetFees`, which returned **(0, 95, 30)** on mainnet — a real total of
/// **125 bps**, not 100. Budgeting off `Global` under-funds every launch by 25 bps and the buy
/// reverts on `TooMuchSolRequired`. Measured against the live program, not read from a field.
///
/// So the rate is stored per sale rather than hardcoded, and only floored here: over-reserving is
/// safe (the surplus stays in the vault), under-reserving fails the launch.
pub const MIN_TOTAL_FEE_BPS: u64 = 125;
/// ⛔ Kept close to pump.fun's live rate (125 bps) on purpose (review, 16 Sep 2026): whatever is
/// reserved above the real fee is USDC the launch buy does not spend, and nothing can move it out
/// of the vault afterwards. At 1,000 bps that was ~8% of a raise; at 150 it is at most 0.25%.
pub const MAX_TOTAL_FEE_BPS: u64 = 150;
pub const BPS: u128 = 10_000;

/// The two legs are ceiled **separately** by the program. Treating them as one combined ceiling
/// under-funds the vault by a lamport on roughly half of all deposits.
#[derive(Clone, Copy, Debug)]
pub struct Fees {
    pub protocol_bps: u128,
    pub creator_bps: u128,
}

impl Fees {
    pub fn new(protocol_bps: u64, creator_bps: u64) -> Self {
        Self { protocol_bps: protocol_bps as u128, creator_bps: creator_bps as u128 }
    }
}

#[inline]
fn ceil_div(a: u128, b: u128) -> u128 {
    a / b + if a % b == 0 { 0 } else { 1 }
}

/// One fee leg, rounded the way the program rounds it.
pub fn apply_fee(amount: u128, bps: u128) -> u128 {
    ceil_div(amount * bps, BPS)
}

/// Curve price plus both fees, each ceiled separately.
pub fn total_with_fees(curve_in: u128, fees: Fees) -> u128 {
    curve_in + apply_fee(curve_in, fees.protocol_bps) + apply_fee(curve_in, fees.creator_bps)
}

/// Splits a gross deposit into the part that buys curve and the part held back for the launch fee.
///
/// The closed form `gross * 10000 / 10100` OVERSHOOTS because of the separate ceilings, so it is
/// only a starting point. The walk-down terminates in at most two steps — the two ceilings can
/// exceed a combined one by at most two lamports — and is bounded so a future fee change cannot
/// turn this into an unbounded loop.
pub fn split_deposit(gross: u128, fees: Fees) -> Result<(u128, u128)> {
    let mut curve_in = gross * BPS / (BPS + fees.protocol_bps + fees.creator_bps);
    let mut steps = 0u8;
    while curve_in > 0 && total_with_fees(curve_in, fees) > gross {
        curve_in -= 1;
        steps += 1;
        require!(steps <= 4, PumpFamilyError::FeeSplitDidNotConverge);
    }
    Ok((curve_in, gross - curve_in))
}

/// Tokens received for `sol_in` lamports against reserves `(vs, vt)`.
///
/// The REMAINING reserve is rounded up, which rounds tokens handed out down. Flooring the reserve
/// instead inflates the result above what the curve will really give, and pricing that inflated
/// figure back through `sol_cost` then costs more than the deposit it came from.
pub fn tokens_out(vs: u128, vt: u128, sol_in: u128, real_reserves: u128) -> u128 {
    if sol_in == 0 {
        return 0;
    }
    let remaining = ceil_div(vs * vt, vs + sol_in);
    let out = vt.saturating_sub(remaining);
    if out > real_reserves {
        real_reserves
    } else {
        out
    }
}

/// Lamports pump.fun will charge for exactly `tokens`, before fees. Ceiled: the vault is paying,
/// and a rounded-down cost is one lamport short of what the program demands.
pub fn sol_cost(tokens: u128, vs: u128, vt: u128) -> Result<u128> {
    if tokens == 0 {
        return Ok(0);
    }
    require!(tokens < vt, PumpFamilyError::CurveExhausted);
    Ok(ceil_div(vs * vt, vt - tokens) - vs)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The live mainnet rate, from the fee program.
    const F: Fees = Fees { protocol_bps: 95, creator_bps: 30 };

    /// The invariant the whole design rests on: sequential shadow buys must never allocate more
    /// than one aggregate buy for the same money would deliver.
    #[test]
    fn stepwise_never_exceeds_aggregate() {
        let mut vs = VS0;
        let mut vt = VT0;
        let mut sold: u128 = 0;
        let mut curve_in_total: u128 = 0;
        for i in 0..1000u128 {
            let gross = 5_000_000 + (i * 7_919) % 200_000_000;
            let (curve_in, _) = split_deposit(gross, F).unwrap();
            let out = tokens_out(vs, vt, curve_in, RT0 - sold);
            vs += curve_in;
            vt -= out;
            sold += out;
            curve_in_total += curve_in;
        }
        let aggregate = tokens_out(VS0, VT0, curve_in_total, RT0);
        assert!(sold <= aggregate, "over-allocated: {} > {}", sold, aggregate);
        assert!(aggregate - sold < 1200, "dust too large: {}", aggregate - sold);
    }

    /// The vault must always hold enough to pay for what it promised.
    #[test]
    fn vault_can_always_pay() {
        let mut vs = VS0;
        let mut vt = VT0;
        let (mut sold, mut curve_in_total, mut fee_held_total) = (0u128, 0u128, 0u128);
        for i in 0..2000u128 {
            let gross = 1_000_000 + (i * 104_729) % 500_000_000;
            let (curve_in, fee_held) = split_deposit(gross, F).unwrap();
            let out = tokens_out(vs, vt, curve_in, RT0 - sold);
            if out == 0 {
                break;
            }
            vs += curve_in;
            vt -= out;
            sold += out;
            curve_in_total += curve_in;
            fee_held_total += fee_held;
        }
        let cost = sol_cost(sold, VS0, VT0).unwrap();
        let required = total_with_fees(cost, F);
        assert!(
            required <= curve_in_total + fee_held_total,
            "vault short by {}",
            required - (curve_in_total + fee_held_total)
        );
    }

    /// The naive combined-ceiling split is genuinely broken; this pins the fix.
    #[test]
    fn walked_down_split_never_underfunds() {
        let mut naive_failures = 0;
        for i in 0..50_000u128 {
            let gross = 1_000_000 + i * 7_919;
            let naive = gross * BPS / (BPS + F.protocol_bps + F.creator_bps);
            if total_with_fees(naive, F) > gross {
                naive_failures += 1;
            }
            let (curve_in, _) = split_deposit(gross, F).unwrap();
            assert!(total_with_fees(curve_in, F) <= gross, "under-funded at {}", gross);
        }
        assert!(naive_failures > 0, "the naive split was supposed to be broken");
    }

    #[test]
    fn cannot_oversell_the_curve() {
        let out = tokens_out(VS0, VT0, 1_000_000_000_000, RT0);
        assert!(out <= RT0);
    }
}

#[cfg(test)]
mod vectors {
    use super::*;

    const F: Fees = Fees { protocol_bps: 95, creator_bps: 30 };

    /// Emits the shadow curve's state after each of a fixed deposit sequence, so `curve.mjs` can
    /// be checked against it base-unit for base-unit. Two implementations of the same arithmetic
    /// is exactly where a rounding divergence hides, and a divergence here means the on-chain
    /// allocation and the number the front end showed the depositor disagree.
    #[test]
    fn emit_vectors() {
        let mut vs = VS0;
        let mut vt = VT0;
        let mut sold: u128 = 0;
        let mut rows = Vec::new();
        for i in 0..200u128 {
            let gross = 3_000_000 + (i * 104_729) % 900_000_000;
            let (curve_in, fee_held) = split_deposit(gross, F).unwrap();
            let out = tokens_out(vs, vt, curve_in, RT0 - sold);
            vs += curve_in;
            vt -= out;
            sold += out;
            rows.push(format!(
                "[{},{},{},{},{},{}]",
                gross, curve_in, fee_held, out, vs, vt
            ));
        }
        std::fs::write(
            concat!(env!("CARGO_MANIFEST_DIR"), "/../../vectors.json"),
            format!("[{}]", rows.join(",")),
        )
        .unwrap();
    }
}

#[cfg(test)]
mod mainnet_observed {
    use super::*;

    /// Pins the real fee against a transaction the live program actually rejected.
    ///
    /// The local validator, running mainnet's cloned pump.fun, demanded 2_456_064_354 lamports for
    /// 80_270_228_907_905 base units. At the 95+5 the `Global` account advertises, the model says
    /// 2_449_999_998 — six million lamports short, and the buy reverts. At 95+30, which is what the
    /// fee program's `GetFees` returns, it matches to the lamport.
    #[test]
    fn matches_a_real_rejection() {
        let tokens: u128 = 80_270_228_907_905;
        let cost = sol_cost(tokens, VS0, VT0).unwrap();
        assert_eq!(cost, 2_425_742_571);
        assert_eq!(total_with_fees(cost, Fees::new(95, 30)), 2_456_064_354);
        assert_ne!(total_with_fees(cost, Fees::new(95, 5)), 2_456_064_354);
    }
}
