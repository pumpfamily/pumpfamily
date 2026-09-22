//! Hand-rolled CPI into pump.fun.
//!
//! There is no published crate, so the instructions are assembled from the on-chain Anchor IDL
//! (fetched and decoded 22 Aug 2026). Two deliberate choices:
//!
//!  - **The pump.fun accounts are passed through unchecked.** pump.fun is itself an Anchor program
//!    whose own `seeds` constraints reject a wrong PDA, so re-deriving them here would burn compute
//!    to repeat a check the callee already makes. What this program *does* validate is the handful
//!    of accounts that are ours: the mint, the vault, and the sale.
//!  - **`buy` sends `track_volume`.** The IDL types it `OptionBool`, a tuple struct wrapping one
//!    bool, so it is a single byte and always present rather than a Borsh `Option`.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke_signed;

/// `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P`
pub const PUMP_PROGRAM: Pubkey = pubkey!("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
/// Metaplex. ⚠ Only the **v1** launch needs it: a v1 coin is a classic SPL mint whose metadata
/// lives in a separate Metaplex account, written by pump.fun with `is_mutable = false`.
pub const MPL_TOKEN_METADATA: Pubkey = pubkey!("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");

const CREATE_DISC: [u8; 8] = [24, 30, 200, 40, 5, 28, 7, 119];
/// `buy_exact_sol_in` — sha256("global:buy_exact_sol_in")[..8]
const BUY_EXACT_SOL_IN_DISC: [u8; 8] = [56, 252, 116, 8, 158, 223, 205, 95];
const BUY_DISC: [u8; 8] = [102, 6, 61, 18, 1, 218, 235, 234];
/// `create_v2` — sha256("global:create_v2")[..8]
const CREATE_V2_DISC: [u8; 8] = [214, 144, 76, 236, 95, 139, 49, 180];
/// `buy_v2` — sha256("global:buy_v2")[..8]
const BUY_V2_DISC: [u8; 8] = [184, 23, 238, 97, 103, 197, 211, 61];
/// `buy_exact_quote_in_v2`, from the on-chain IDL.
const BUY_EXACT_QUOTE_IN_V2_DISC: [u8; 8] = [194, 171, 28, 70, 104, 77, 91, 47];

/// Builds the account metas from an index list, so a wrong flag is a wrong constant rather than a
/// wrong line of code. Every flag below was read off pump.fun's own IDL, not inferred.
fn metas(accounts: &[AccountInfo], writable: &[usize], signer: &[usize]) -> Vec<AccountMeta> {
    accounts
        .iter()
        .enumerate()
        .map(|(i, a)| {
            if writable.contains(&i) {
                AccountMeta::new(a.key(), signer.contains(&i))
            } else {
                AccountMeta::new_readonly(a.key(), signer.contains(&i))
            }
        })
        .collect()
}

/// `create` — the v1 SOL-quoted launch.
///
/// `creator` is the argument that seeds `creator_vault` and decides who may ever collect creator
/// fees. It is set ONCE: `set_creator` needs pump.fun's own authority, so a wrong value here makes
/// this launch's creator fees unreachable forever.
#[allow(clippy::too_many_arguments)]
pub fn create<'info>(
    accounts: &[AccountInfo<'info>],
    name: String,
    symbol: String,
    uri: String,
    creator: Pubkey,
    signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    let mut data = Vec::with_capacity(128);
    data.extend_from_slice(&CREATE_DISC);
    name.serialize(&mut data)?;
    symbol.serialize(&mut data)?;
    uri.serialize(&mut data)?;
    data.extend_from_slice(creator.as_ref());

    // Order is the IDL's, and it is load-bearing: Anchor resolves accounts positionally.
    // 0 mint(s,w) 1 mint_authority 2 bonding_curve(w) 3 associated_bonding_curve(w) 4 global
    // 5 mpl_token_metadata 6 metadata(w) 7 user(s,w) 8 system 9 token 10 ata 11 rent
    // 12 event_authority 13 program
    let metas = vec![
        AccountMeta::new(accounts[0].key(), true),
        AccountMeta::new_readonly(accounts[1].key(), false),
        AccountMeta::new(accounts[2].key(), false),
        AccountMeta::new(accounts[3].key(), false),
        AccountMeta::new_readonly(accounts[4].key(), false),
        AccountMeta::new_readonly(accounts[5].key(), false),
        AccountMeta::new(accounts[6].key(), false),
        AccountMeta::new(accounts[7].key(), true),
        AccountMeta::new_readonly(accounts[8].key(), false),
        AccountMeta::new_readonly(accounts[9].key(), false),
        AccountMeta::new_readonly(accounts[10].key(), false),
        AccountMeta::new_readonly(accounts[11].key(), false),
        AccountMeta::new_readonly(accounts[12].key(), false),
        AccountMeta::new_readonly(accounts[13].key(), false),
    ];

    invoke_signed(
        &Instruction { program_id: PUMP_PROGRAM, accounts: metas, data },
        accounts,
        signer_seeds,
    )
    .map_err(Into::into)
}

/// `buy` — 16 declared accounts plus two the IDL cannot describe.
///
/// The remaining accounts are `bonding_curve_v2` and ONE buyback fee recipient. This is the shape
/// that has landed real mainnet buys; older notes claiming all eight recipients are required
/// predate the `bonding_curve_v2` fix and are wrong.
/// `create_v2` — the launch that a quote-mint or cashback coin needs.
///
/// ⚠ **Nineteen accounts, not the sixteen the IDL lists.** A quote-mint launch appends
/// `quote_mint`, the curve's associated quote account, and the quote token program. Read off a
/// real USDC launch rather than inferred; see PUMPFUN-OPTIONS.md.
///
/// ⚠ **The coin is Token-2022.** Account 7 is `TokenzQd…`, not the classic token program, which
/// is also why there is no Metaplex metadata account here — it lives in the mint's extension.
///
/// ⛔ `is_mayhem_mode` is hard-coded false and takes no parameter. Mayhem lets pump.fun mutate the
/// curve's virtual reserves after creation, which would invalidate every price this program quoted
/// during a window that can last days. It must never be true here.
#[allow(clippy::too_many_arguments)]
pub fn create_v2<'info>(
    accounts: &[AccountInfo<'info>],
    name: String,
    symbol: String,
    uri: String,
    creator: Pubkey,
    holder_rewards: bool,
    creator_fee_bps: u64,
    signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    let mut data = Vec::with_capacity(170);
    data.extend_from_slice(&CREATE_V2_DISC);
    name.serialize(&mut data)?;
    symbol.serialize(&mut data)?;
    uri.serialize(&mut data)?;
    data.extend_from_slice(creator.as_ref());
    data.push(0); // is_mayhem_mode — never true, see above
    data.push(0); // is_cashback_enabled — deprecated by pump.fun, must be false
    // creator_fee_bps: honoured only on a custom pair (pump.fun error 6091 refuses it on SOL or a
    // whitelisted quote), so every SOL launch passes 0 and a pair launch passes the sale's choice.
    data.extend_from_slice(&creator_fee_bps.to_le_bytes());
    // is_holder_reward — pump.fun's replacement for cashback (Sep 2026): the creator fee leg goes to
    // the coin's holders instead of the creator, permanently.
    data.push(holder_rewards as u8);

    //  0 mint(w,s) 1 mint_authority 2 bonding_curve(w) 3 associated_bonding_curve(w) 4 global
    //  5 user(w,s) 6 system 7 token_2022 8 associated_token 9 mayhem_program(w) 10 global_params
    // 11 sol_vault(w) 12 mayhem_state(w) 13 mayhem_token_vault(w) 14 event_authority 15 program
    // 16 quote_mint 17 associated_quote_bonding_curve(w) 18 quote_token_program
    // 19 quote_control — a CUSTOM PAIR only; a SOL launch stops at 18.
    let metas = metas(accounts, &[0, 2, 3, 5, 9, 11, 12, 13, 17], &[0, 5]);
    invoke_signed(
        &Instruction { program_id: PUMP_PROGRAM, accounts: metas, data },
        accounts,
        signer_seeds,
    )
    .map_err(Into::into)
}

/// `buy_exact_quote_in_v2` — spend a known amount of the PAIR token on a custom-pair curve.
///
/// The pair-launch twin of `buy_exact_sol_in`: the known quantity is what the swap at the close
/// delivered, and this takes exactly that. 27 accounts, the same list as `buy_v2`, in IDL order.
pub fn buy_exact_quote_in_v2<'info>(
    accounts: &[AccountInfo<'info>],
    spendable_quote_in: u64,
    min_tokens_out: u64,
    signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    let mut data = Vec::with_capacity(24);
    data.extend_from_slice(&BUY_EXACT_QUOTE_IN_V2_DISC);
    data.extend_from_slice(&spendable_quote_in.to_le_bytes());
    data.extend_from_slice(&min_tokens_out.to_le_bytes());

    //  0 global 1 base_mint 2 quote_mint 3 base_token_program 4 quote_token_program 5 ata_program
    //  6 fee_recipient(w) 7 associated_quote_fee_recipient(w) 8 buyback_fee_recipient(w)
    //  9 associated_quote_buyback_fee_recipient(w) 10 bonding_curve(w) 11 associated_base_bonding_curve(w)
    // 12 associated_quote_bonding_curve(w) 13 user(w,s) 14 associated_base_user(w)
    // 15 associated_quote_user(w) 16 creator_vault(w) 17 associated_creator_vault(w) 18 sharing_config
    // 19 global_volume_accumulator 20 user_volume_accumulator(w) 21 associated_user_volume_accumulator(w)
    // 22 fee_config 23 fee_program 24 system 25 event_authority 26 program
    let metas = metas(accounts, &[6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 20, 21], &[13]);
    invoke_signed(
        &Instruction { program_id: PUMP_PROGRAM, accounts: metas, data },
        accounts,
        signer_seeds,
    )
    .map_err(Into::into)
}

/// `buy_v2` — the quote-denominated buy. 27 accounts, and `max_quote_cost` is in the QUOTE's base
/// units, so for USDC that is 6 decimals rather than 9.
pub fn buy_v2<'info>(
    accounts: &[AccountInfo<'info>],
    amount: u64,
    max_quote_cost: u64,
    signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    let mut data = Vec::with_capacity(24);
    data.extend_from_slice(&BUY_V2_DISC);
    data.extend_from_slice(&amount.to_le_bytes());
    data.extend_from_slice(&max_quote_cost.to_le_bytes());
    // ⚠ No third argument here, unlike v1 `buy`. Confirmed against a real BuyV2: its data is
    // exactly 24 bytes with nothing trailing.

    let metas = metas(accounts, &[6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 20, 21], &[13]);
    invoke_signed(
        &Instruction { program_id: PUMP_PROGRAM, accounts: metas, data },
        accounts,
        signer_seeds,
    )
    .map_err(Into::into)
}

pub fn buy<'info>(
    accounts: &[AccountInfo<'info>],
    amount: u64,
    max_sol_cost: u64,
    track_volume: bool,
    signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    let mut data = Vec::with_capacity(25);
    data.extend_from_slice(&BUY_DISC);
    data.extend_from_slice(&amount.to_le_bytes());
    data.extend_from_slice(&max_sol_cost.to_le_bytes());
    // `track_volume`, the third argument. The IDL types it as `OptionBool`, which is a tuple
    // struct wrapping one bool rather than a Borsh Option, so it is a single byte and always
    // present. This program shipped without it and the buy still landed, so the deployed program
    // tolerates the short form — but sending it opts the vault's buy into volume accumulation,
    // which is what feeds cashback and token incentives.
    data.push(track_volume as u8);

    // 0 global 1 fee_recipient(w) 2 mint 3 bonding_curve(w) 4 associated_bonding_curve(w)
    // 5 associated_user(w) 6 user(s,w) 7 system 8 token 9 creator_vault(w) 10 event_authority
    // 11 program 12 global_volume_accumulator 13 user_volume_accumulator(w) 14 fee_config
    // 15 fee_program  || 16 bonding_curve_v2  17 buyback_fee_recipient(w)
    let writable = [1usize, 3, 4, 5, 6, 9, 13, 17];
    let signer = [6usize];
    let metas: Vec<AccountMeta> = accounts
        .iter()
        .enumerate()
        .map(|(i, a)| {
            if writable.contains(&i) {
                AccountMeta::new(a.key(), signer.contains(&i))
            } else {
                AccountMeta::new_readonly(a.key(), signer.contains(&i))
            }
        })
        .collect();

    invoke_signed(
        &Instruction { program_id: PUMP_PROGRAM, accounts: metas, data },
        accounts,
        signer_seeds,
    )
    .map_err(Into::into)
}

/// `buy_exact_sol_in` — spend a known amount of SOL on a `create_v2` curve.
///
/// ⭐ This is what pump.fun's own launches use on a WSOL-quoted `create_v2` coin, and it is the
/// better fit for this program anyway: a launch spends what the swap ACTUALLY returned, so the
/// known quantity is lamports, not a token count. `buy` asks for an exact token amount and a SOL
/// ceiling, which means computing the curve twice and hoping the second answer matches.
///
/// ⚠ **Eighteen accounts, not the sixteen the IDL lists** — the same two `buy` appends, read off
/// the same real launch: `bonding_curve_v2` and ONE buyback fee recipient.
///
/// ⚠ Account 8 is the COIN's token program, which for a `create_v2` coin is Token-2022. The quote
/// side takes no account here at all: the SOL leaves `user` natively and pump.fun wraps it.
pub fn buy_exact_sol_in<'info>(
    accounts: &[AccountInfo<'info>],
    spendable_sol_in: u64,
    min_tokens_out: u64,
    track_volume: bool,
    signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    let mut data = Vec::with_capacity(25);
    data.extend_from_slice(&BUY_EXACT_SOL_IN_DISC);
    data.extend_from_slice(&spendable_sol_in.to_le_bytes());
    data.extend_from_slice(&min_tokens_out.to_le_bytes());
    // `track_volume` is an `OptionBool`: a tuple struct around one bool, so one byte, always
    // present. Measured on a real launch — its data is exactly 25 bytes.
    data.push(track_volume as u8);

    //  0 global 1 fee_recipient(w) 2 mint 3 bonding_curve(w) 4 associated_bonding_curve(w)
    //  5 associated_user(w) 6 user(s,w) 7 system 8 token_2022 9 creator_vault(w)
    // 10 event_authority 11 program 12 global_volume_accumulator 13 user_volume_accumulator(w)
    // 14 fee_config 15 fee_program || 16 bonding_curve_v2 17 buyback_fee_recipient(w)
    let metas = metas(accounts, &[1, 3, 4, 5, 6, 9, 13, 17], &[6]);
    invoke_signed(
        &Instruction { program_id: PUMP_PROGRAM, accounts: metas, data },
        accounts,
        signer_seeds,
    )
    .map_err(Into::into)
}
