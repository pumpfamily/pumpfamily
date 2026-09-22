//! Turning the raise into SOL, through Raydium's AMM v4.
//!
//! Buyers pay USDC because that is what FOMO sends. The coin launches on pump.fun's **SOL** curve.
//! So at the close, once, the whole raise is swapped — and this is the only place in the program
//! where money leaves the vault before the launch.
//!
//! ## What is actually trusted
//!
//! Raydium's `swap_base_in` takes eighteen accounts, most of them the pool's OpenBook market. This
//! module does **not** try to re-validate that list: Raydium checks every one of them against the
//! pool's own fields and fails if any is wrong. What it pins is the one account that decides which
//! market we are trading in at all — `SWAP_POOL` — and then it bounds the OUTCOME:
//!
//!  - `minimum_amount_out` is computed **by the program**, from the pool's own reserves, never
//!    supplied by the caller;
//!  - the lamports the vault actually gained are measured before and after, and the swap is
//!    rejected if the gain falls short.
//!
//! ⭐ That is the guard that holds even if Raydium's account list changes shape: a cranker cannot
//! route the money anywhere that does not return the SOL, because the balance check runs last.
//!
//! ⚠ Reserves are read as the vaults' balances. Raydium's own accounting subtracts
//! `need_take_pnl_*` from those, so this overestimates the reserves by a hair and therefore
//! overestimates the expected output — which makes `minimum_amount_out` very slightly strict, in
//! the safe direction, and well inside `SLIPPAGE_BPS`.
use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke_signed;

use crate::PumpFamilyError;

/// `swap_base_in`. Raydium's instructions are indexed, not discriminated.
const SWAP_BASE_IN: u8 = 9;

/// How far below the pool's own quote the swap may land before it is refused.
///
/// This is not a fee — it is the room for other people trading the same pool in the same slot. One
/// percent is far outside anything a $12k trade moves in a pool holding nineteen million, and
/// tight enough that a pool being drained while we trade does not go through.
pub const SLIPPAGE_BPS: u128 = 100;

/// Raydium's own fee, in basis points of the input. 0.25% on this pool, read from its config.
const POOL_FEE_BPS: u128 = 25;

/// What the pool would return for `amount_in`, by the same constant product it runs.
///
/// The arithmetic this program already does everywhere else — `tokens_out` on the shadow curve is
/// the identical shape. Which is the argument for this venue over a concentrated one: the maths is
/// something the program can check for itself.
pub fn quote_out(sol_reserve: u128, usdc_reserve: u128, amount_in: u128) -> Result<u128> {
    require!(sol_reserve > 0 && usdc_reserve > 0, PumpFamilyError::BadSwapPool);
    let after_fee = amount_in
        .checked_mul(10_000 - POOL_FEE_BPS)
        .ok_or(PumpFamilyError::MathOverflow)?
        / 10_000;
    let k = sol_reserve
        .checked_mul(usdc_reserve)
        .ok_or(PumpFamilyError::MathOverflow)?;
    let usdc_after = usdc_reserve
        .checked_add(after_fee)
        .ok_or(PumpFamilyError::MathOverflow)?;
    // Floor division leaves the remainder in the pool, which is the direction that cannot
    // over-promise the swap.
    Ok(sol_reserve - (k / usdc_after))
}

/// The least SOL we will accept for `amount_in`, at the pool's current state.
pub fn minimum_out(sol_reserve: u128, usdc_reserve: u128, amount_in: u128) -> Result<u64> {
    let expected = quote_out(sol_reserve, usdc_reserve, amount_in)?;
    let floor = expected
        .checked_mul(10_000 - SLIPPAGE_BPS)
        .ok_or(PumpFamilyError::MathOverflow)?
        / 10_000;
    require!(floor > 0, PumpFamilyError::SwapReturnedTooLittle);
    u64::try_from(floor).map_err(|_| PumpFamilyError::MathOverflow.into())
}

/// `swap_base_in`, signed by the vault.
///
/// `accounts` is Raydium's list in Raydium's order, passed through from the caller. The vault is
/// the source owner and signs with its seeds; nothing here is signed by the cranker except the
/// fee.
#[allow(clippy::too_many_arguments)]
pub fn swap_base_in<'info>(
    raydium: &AccountInfo<'info>,
    accounts: &[AccountInfo<'info>],
    amount_in: u64,
    minimum_amount_out: u64,
    signers: &[&[&[u8]]],
) -> Result<()> {
    require!(accounts.len() >= 17, PumpFamilyError::BadSwapPool);
    let mut data = Vec::with_capacity(17);
    data.push(SWAP_BASE_IN);
    data.extend_from_slice(&amount_in.to_le_bytes());
    data.extend_from_slice(&minimum_amount_out.to_le_bytes());

    // Raydium's shape: everything is writable except the two programs and the authority, and the
    // LAST account is the source owner, which is the only signer.
    let last = accounts.len() - 1;
    let readonly = [0usize, 2, 7];
    let metas: Vec<AccountMeta> = accounts
        .iter()
        .enumerate()
        .map(|(i, a)| {
            if readonly.contains(&i) {
                AccountMeta::new_readonly(a.key(), false)
            } else if i == last {
                AccountMeta::new_readonly(a.key(), true)
            } else {
                AccountMeta::new(a.key(), false)
            }
        })
        .collect();

    let mut infos = accounts.to_vec();
    infos.push(raydium.clone());
    invoke_signed(
        &Instruction { program_id: raydium.key(), accounts: metas, data },
        &infos,
        signers,
    )
    .map_err(Into::into)
}
