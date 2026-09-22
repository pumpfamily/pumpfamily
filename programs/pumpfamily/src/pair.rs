//! Launching a coin paired with one of pump.fun's **custom liquidity tokens** instead of SOL.
//!
//! pump.fun keeps a second allowlist, separate from `Global.whitelisted_quote_mints` (which holds
//! USDC alone): the `QuoteControl` account at PDA `["quote-control"]`, a vector of mints each with
//! its own opening virtual reserve. 168 mints on 21 Sep 2026 — xStocks, WIF, PENGU, BONK and many
//! pump coins. A coin paired with one of them is a plain `create_v2` with four accounts appended:
//! `[quote_mint, associated_quote_bonding_curve, quote_token_program, quote_control]`. Read off
//! real launches from pump.fun's own site, not inferred.
//!
//! ⭐ Nothing about the WINDOW changes. Buyers still send USDC from FOMO, `credit` still prices each
//! deposit on the SOL shadow curve, and `swap_to_sol` still turns the raise into SOL at the close.
//! A pair sale adds exactly one step after that — `swap_to_pair`, SOL into the pair token through
//! Jupiter, which is what Axiom and FOMO do on every buy of such a coin — and launches with
//! `launch_pair`. `distribute` is untouched: it already pays `allocation × tokens_received / sold`,
//! one factor for everyone, so whatever the two swaps cost lands on every buyer alike.
//!
//! ## What is trusted
//!
//! The Jupiter route is chosen by the **attester**, the watcher this program already trusts to
//! attribute deposits, and it names the least it will accept. That is the same trust a buyer
//! extends to Axiom's backend when it routes their SOL. What the program bounds regardless:
//!
//!  - only the attester may call it, once, between the SOL swap and the launch;
//!  - the pair token must still be on pump.fun's list at that moment, so we never swap into a
//!    token pump.fun would then refuse to launch against;
//!  - **every** lamport of `sol_in` must be spent — a route that swaps less would leave buyers'
//!    SOL in the vault, where `sweep_lamports` would hand it to the sale authority;
//!  - the vault's pair-token account must gain at least `min_out`.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke_signed;

use crate::PumpFamilyError;

/// pump.fun's custom-pair allowlist, PDA `["quote-control"]` of pump.fun.
pub const QUOTE_CONTROL: Pubkey = pubkey!("6z6GDdfb2AjR9ZhJmAUQ5cipJCVxQvLJhB2H8mCwTFBP");
/// Jupiter's aggregator v6.
pub const JUPITER: Pubkey = pubkey!("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");
/// pump.fun's own ceiling for a custom pair's creator fee (`Global.max_configurable_creator_fee_bps`,
/// read 21 Sep 2026). Real pair launches from pump.fun's site use 0, 30, 100, 200 and 300.
pub const MAX_PAIR_CREATOR_FEE_BPS: u64 = 300;

/// `QuoteControl`: 8 discriminator, 32 admin, 64 reserved, then a Borsh `Vec` of
/// `{ mint: Pubkey, initial_virtual_quote_reserves: u64 }`.
const QC_LEN_OFFSET: usize = 8 + 32 + 64;
const QC_ENTRY: usize = 40;

/// Whether `mint` is on pump.fun's custom-pair list right now.
pub fn is_listed_pair(quote_control: &AccountInfo, mint: &Pubkey) -> Result<bool> {
    require_keys_eq!(quote_control.key(), QUOTE_CONTROL, PumpFamilyError::BadQuoteControl);
    require_keys_eq!(*quote_control.owner, crate::pump::PUMP_PROGRAM, PumpFamilyError::BadQuoteControl);
    let data = quote_control.try_borrow_data()?;
    require!(data.len() >= QC_LEN_OFFSET + 4, PumpFamilyError::BadQuoteControl);
    let n = u32::from_le_bytes(data[QC_LEN_OFFSET..QC_LEN_OFFSET + 4].try_into().unwrap()) as usize;
    let start = QC_LEN_OFFSET + 4;
    require!(data.len() >= start + n * QC_ENTRY, PumpFamilyError::BadQuoteControl);
    let want = mint.as_ref();
    Ok((0..n).any(|i| &data[start + i * QC_ENTRY..start + i * QC_ENTRY + 32] == want))
}

/// The pair a sale launches against. One per sale, PDA `["pair", sale]`, written once at open.
#[account]
pub struct SalePair {
    pub sale: Pubkey,
    /// The pair token — pump.fun's `quote_mint` for this coin.
    pub mint: Pubkey,
    /// The pair token's own token program; classic SPL or Token-2022, and it differs per token.
    pub token_program: Pubkey,
    /// pump.fun's `creator_fee_bps` for this coin, 0..=300. Permanent once the coin exists.
    pub creator_fee_bps: u64,
    /// Pair-token base units the swap at the close delivered. 0 until `swap_to_pair`.
    pub pair_in: u64,
    pub bump: u8,
}

impl SalePair {
    pub const SIZE: usize = 8 + 32 + 32 + 32 + 8 + 8 + 1;
}

/// Invokes Jupiter with the route the attester built, signed by the vault.
///
/// The account list is passed through as given, except that the vault is marked a signer: it is
/// the swap's `user`, and the outer transaction cannot sign for a PDA.
pub fn jupiter_route<'info>(
    jupiter: &AccountInfo<'info>,
    accounts: &[AccountInfo<'info>],
    vault: &Pubkey,
    data: Vec<u8>,
    signers: &[&[&[u8]]],
) -> Result<()> {
    let metas: Vec<AccountMeta> = accounts
        .iter()
        .map(|a| AccountMeta {
            pubkey: a.key(),
            is_signer: a.key() == *vault,
            is_writable: a.is_writable,
        })
        .collect();
    let mut infos = accounts.to_vec();
    infos.push(jupiter.clone());
    invoke_signed(&Instruction { program_id: JUPITER, accounts: metas, data }, &infos, signers)
        .map_err(Into::into)
}

/// Reads an SPL / Token-2022 account's `amount` without deserialising extensions.
pub fn token_amount(a: &AccountInfo) -> Result<u64> {
    let d = a.try_borrow_data()?;
    require!(d.len() >= 72, PumpFamilyError::WrongTokenAccount);
    Ok(u64::from_le_bytes(d[64..72].try_into().unwrap()))
}
