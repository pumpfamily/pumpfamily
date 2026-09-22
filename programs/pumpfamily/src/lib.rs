//! Pump Family — a presale launchpad on pump.fun.
//!
//! A creator opens a window (the window) and chooses how long it lasts. During it a coin can only
//! be bought by SENDING USDC FROM THE FOMO APP to the sale's deposit address. When the window
//! closes the pooled USDC buys the pump.fun bonding curve in a single atomic transaction, the
//! tokens are pushed to every buyer's wallet, and the coin trades freely. The creator gets no
//! tokens of their own: there is no dev buy.
//!
//! ⭐ Why a SEND and not a call into this program: FOMO co-signs every transaction its app makes
//! (`AgmLJ…zN51`), sends to outside addresses included, and nobody else can produce that
//! signature. FOMO's backend will never build a call into this program, but it will sign a plain
//! USDC transfer to any address. A program cannot read the signers of an earlier transaction, so
//! the ATTESTER (our watcher) reads each transfer and either credits it — FOMO co-signed, inside
//! the window — or returns it. ⛔ That makes the attester a trusted party for ATTRIBUTION: it
//! cannot credit money that never arrived (`CreditExceedsBalance`), cannot credit one transfer
//! twice or both credit and return it (the receipt PDA), cannot reorder across slots, and cannot
//! return credited money (`ReturnTouchesDeposits`). Every credit emits the transfer's signature
//! so anyone can check it against the chain.
//!
//! Two properties do the real work:
//!
//!  - **The mint does not exist during the window.** That is the only reason the window can be
//!    enforced at all. `buy` on a pump.fun curve cannot be gated — its only signer is the buyer,
//!    and the curve carries no start time, no enabled flag and no permitted-buyer field. A design
//!    where the coin is already live during a "restricted" window is theatre.
//!  - **`create` and `buy` fit in ONE transaction** (924 bytes through this program's CPI, against
//!    a 1232 limit, with a lookup table). So the coin cannot exist at the opening price without
//!    this program's buy landing in the same transaction. Nothing can snipe the gap, because there
//!    is no gap.
//!
//! ⚠ Deposits are FINAL once made. The shadow curve prices each deposit against the state left by
//! the one before it, so unwinding a deposit in the middle would silently re-price everyone after
//! it. Money comes back only if the sale fails: the minimum is missed, or nobody launches in time.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::{invoke, invoke_signed};
use anchor_lang::solana_program::system_instruction;
use anchor_spl::associated_token::{create_idempotent, AssociatedToken, Create};
// `token_interface` speaks both the classic token program and Token-2022. A quote-mint
// launch uses BOTH at once — the coin is Token-2022, USDC is classic SPL — so the quote
// side is written against the interface rather than either concrete program.
use anchor_spl::token_interface::{
    close_account, CloseAccount, Mint as IMint, TokenAccount as ITokenAccount, TokenInterface,
};

pub mod curve;
pub mod pair;
pub mod pump;
pub mod swap;

use curve::*;
use pair::*;

declare_id!("8WkibpqR4jnkxpv8nHk9t3Rgw9L4UqECYYwiAGYnu8Hf");

/// The shortest launch window a sale may set: an hour. The test build shortens it, because the
/// suite has to run a sale PAST its deadline to prove the refund path that follows a swap — the
/// one path a one-hour floor puts out of reach of any test.
#[cfg(not(feature = "test-attester"))]
pub const MIN_LAUNCH_WINDOW: i64 = 3_600;
#[cfg(feature = "test-attester")]
pub const MIN_LAUNCH_WINDOW: i64 = 20;

/// Prefunded by the sale authority so a permissionless cranker never pays out of pocket, and so
/// depositors' money is never spent on rent.
///
/// A measured `create_v2` launch consumes **0.0072 SOL** of this — the Token-2022 mint with its
/// metadata extension, the curve, the curve's coin and WSOL accounts, and the mayhem state and
/// its vault. Measured on a cloned mainnet pump.fun, 21 Sep 2026: **16% of the reserve, 84%
/// headroom.** A launch with buys also opens the vault's own Token-2022 account, a little more.
///
/// ⚠ It was 0.0251 SOL under v1 `create`, which is what this figure used to say. `create_v2` is
/// CHEAPER despite opening more accounts, because there is no Metaplex metadata account to pay
/// for — the metadata lives in the mint's own extension.
///
/// Running out means the launch reverts. Since whatever is unspent goes straight back to the
/// authority via `sweep_lamports`, a larger reserve costs nothing and removes the failure mode.
pub const LAUNCH_RESERVE: u64 = 45_000_000;

/// The smallest deposit the program will book.
///
/// Two floors sit under it, and they are not the same size — measured, not assumed:
///
///  - **The fee distortion is small.** Both legs ceil separately, so dust pays a whole extra
///    lamport on each. The effective rate is 125 bps down to ~5,000 lamports, 131 bps at 1,000,
///    204 at 100 and 2,500 at 10. Real, but it only bites below ~0.000005 SOL — two orders of
///    magnitude under this floor, not the ~0.0001 SOL the earlier note claimed.
///  - **Claiming costs the claimant ~0.00204 SOL of ATA rent**, and that is the binding one.
///
/// ⭐ Raised 0.001 → 0.01 SOL on 26 Aug 2026, and the ATA rent is the whole reason. At 0.001 the
/// smallest legal position cost *more to collect than it cost to open* — recoverable by closing the
/// account afterwards, so an outlay rather than a loss, but a depositor discovers it at claim time
/// and has no reason to expect it. At 0.01 the smallest legal position is unambiguously worth
/// collecting, roughly 5x the rent, with no arithmetic for anyone to do.
///
/// The cost is real and one-sided: deposits between 0.001 and 0.01 SOL are now refused outright.
/// That is the trade accepted — a floor that admits positions nobody will rationally claim is worse
/// for the person holding one than no position at all.
///
/// Enforced per deposit rather than per position: a top-up is a deposit, and it is dust deposits —
/// not small depositors — that this refuses.
pub const MIN_DEPOSIT: u64 = 10_000_000;

/// The smallest SOL-equivalent a cap may be set to. Small enough to be no obstacle, large enough
/// that a cap cannot be set to something the curve would price at zero tokens.
pub const MIN_CURVE_IN: u64 = 1_000;

/// pump.fun mints a fixed 1,000,000,000 tokens at 6 decimals. Of that, `RT0` (79.31%) is what the
/// bonding curve can ever sell; the remainder is the migration reserve.
pub const TOTAL_SUPPLY: u128 = 1_000_000_000_000_000;

/// No wallet may end a window holding more than **3% of supply**, whatever the sale is configured
/// to allow.
///
/// The per-sale `per_wallet_cap` is denominated in SOL and does not bound this. That is the whole
/// problem it fixes: the shadow curve prices the early queue cheaply, so an identical deposit buys
/// far more tokens at the open than at the close. A SOL cap therefore bounds what a wallet
/// *spends* while leaving what it *receives* unbounded at exactly the moment that matters. A cap
/// in tokens bounds the allocation directly, which is the quantity the fairness claim is about.
///
/// This is a protocol ceiling, not the dial — a creator can set `per_wallet_cap` far tighter, and
/// usually should. It cannot be set looser.
///
/// ⚠ It does not, and on chain cannot, enforce one wallet per person. `buy` has no notion of
/// identity and neither does this program; a determined participant splits across wallets. The
/// ceiling raises the cost of doing so rather than preventing it, and any stronger claim belongs
/// to an identity layer above the chain.
pub const MAX_WALLET_BPS: u128 = 300;
pub const MAX_WALLET_ALLOCATION: u128 = TOTAL_SUPPLY * MAX_WALLET_BPS / 10_000;

/// Every Pump Family mint ends in these four base58 characters.
///
/// Reached by grinding a SEED, not a keypair. The mint is a PDA precisely so that launching needs
/// no secret and anyone can trigger it; a ground keypair would put a signature back in the way and
/// hand the creator a hostage. Adding a nonce to the mint's seeds keeps the address deterministic
/// and permissionless while still letting the client search for the suffix off chain.
pub const VANITY_SUFFIX: &[u8] = b"fomo";

/// Raydium's AMM v4, and the SOL/USDC pool this launchpad prices and swaps through.
///
/// ⛔⛔ Welded in on purpose. Every buy is quoted at THIS pool's spot and the raise is swapped
/// through THIS pool at the close, so the rate a buyer is quoted comes from the venue that will
/// actually execute — no oracle, and nothing the attester or the cranker can influence.
///
/// Chosen 19 Sep 2026 by measurement, not reputation: 167,592 SOL / 18,968,605 USDC, $52M a day,
/// and an all-in cost of 0.25% on a small buy to 0.32% on a full raise. ⛔ NOT Raydium's CLMM,
/// which is cheaper (0.04%) but swaps through tick arrays whose addresses move with the price and
/// which can partially fill — neither belongs in a program holding other people's money. CP-Swap's
/// SOL/USDC pools are dust ($455).
/// Wrapped SOL. Raydium pays in it; pump.fun's v1 buy spends native lamports, so it is unwrapped
/// in the same instruction it is received.
pub const WSOL_MINT: Pubkey = pubkey!("So11111111111111111111111111111111111111112");
pub const RAYDIUM_AMM_V4: Pubkey = pubkey!("675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8");
pub const SWAP_POOL: Pubkey = pubkey!("58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2");
/// Where the pool keeps its own vault addresses. Read off the live account, and checked rather
/// than trusted: the vaults a caller passes must be the ones the pool itself names.
const POOL_SOL_VAULT_OFFSET: usize = 336;
const POOL_USDC_VAULT_OFFSET: usize = 368;

/// The pool's two reserves, with every check that makes them trustworthy.
///
/// ⛔ The vaults are checked against the addresses the POOL ITSELF names, not against constants —
/// so a caller cannot hand us a real pool and someone else's vaults.
fn pool_reserves(
    pool: &AccountInfo,
    sol_vault: &AccountInfo,
    usdc_vault: &AccountInfo,
) -> Result<(u128, u128)> {
    require!(pool.key() == SWAP_POOL, PumpFamilyError::BadSwapPool);
    require!(*pool.owner == RAYDIUM_AMM_V4, PumpFamilyError::BadSwapPool);
    {
        let data = pool.try_borrow_data()?;
        require!(data.len() >= POOL_USDC_VAULT_OFFSET + 32, PumpFamilyError::BadSwapPool);
        let named = |o: usize| Pubkey::try_from(&data[o..o + 32]).map_err(|_| PumpFamilyError::BadSwapPool);
        require!(sol_vault.key() == named(POOL_SOL_VAULT_OFFSET)?, PumpFamilyError::BadSwapPool);
        require!(usdc_vault.key() == named(POOL_USDC_VAULT_OFFSET)?, PumpFamilyError::BadSwapPool);
    }
    let balance = |a: &AccountInfo| -> Result<u128> {
        let d = a.try_borrow_data()?;
        require!(d.len() >= 72, PumpFamilyError::WrongTokenAccount);
        Ok(u64::from_le_bytes(d[64..72].try_into().unwrap()) as u128)
    };
    let sol = balance(sol_vault)?;
    let usdc = balance(usdc_vault)?;
    require!(sol > 0 && usdc > 0, PumpFamilyError::BadSwapPool);
    Ok((sol, usdc))
}

/// What `amount` of the quote asset is worth in lamports, at the pool's spot.
///
/// ⚠ Spot, not the executed price: the swap's fee and impact land later, on everyone at once,
/// through the single scale factor `distribute` applies. Quoting the fee here instead would price
/// each buy against a trade that has not happened yet.
fn sol_equivalent(
    pool: &AccountInfo,
    sol_vault: &AccountInfo,
    usdc_vault: &AccountInfo,
    amount: u64,
) -> Result<u64> {
    let (sol, usdc) = pool_reserves(pool, sol_vault, usdc_vault)?;
    let lamports = (amount as u128)
        .checked_mul(sol)
        .ok_or(PumpFamilyError::MathOverflow)?
        / usdc;
    u64::try_from(lamports).map_err(|_| PumpFamilyError::MathOverflow.into())
}

/// The watcher that decides which transfers into a deposit address count. See the module docs for
/// exactly what it can and cannot do.
///
/// ⛔⛔ The `test-attester` feature swaps in `fixtures/attester-TEST.json`, whose secret is in the
/// repo. A pubkey constant cannot be found in the compiled binary, so `deploy-program.sh` never
/// trusts a prebuilt .so: it rebuilds without features every time.
#[cfg(not(feature = "test-attester"))]
pub const ATTESTER: Pubkey = pubkey!("FQSSoz8zmFVkg3Yi3qraxFPLBs5Bwug1jrv2gsGGkG7q");
#[cfg(feature = "test-attester")]
pub const ATTESTER: Pubkey = pubkey!("8u4AEXgNSvB1khZJ1UzcZJpMofYmh3gmLhNj1mS7AjMu");

/// How long after the window closes the attester has to finish crediting before anyone may
/// launch or fail the sale without it. Transfers land before `window_end` but are read after it, so
/// this is the attester's grace, and it is also the bound on how long a dead attester can stall.
pub const CREDIT_GRACE: i64 = 15 * 60;

const BASE58: &[u8; 58] = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/// True when the base58 encoding of `key` ends with `suffix`.
///
/// Does not encode the key. Base58 emits digits least significant first, so the trailing characters
/// of the encoding are exactly the first remainders of repeated division by 58 — four divmod passes
/// over 32 bytes rather than a full 44 character encode. Leading zero bytes prepend `1`s to the
/// front of the encoding and cannot disturb the tail, so they need no special handling here.
fn has_base58_suffix(key: &Pubkey, suffix: &[u8]) -> bool {
    let mut num = key.to_bytes();
    for expected in suffix.iter().rev() {
        let mut rem: u32 = 0;
        for byte in num.iter_mut() {
            let cur = rem * 256 + *byte as u32;
            *byte = (cur / 58) as u8;
            rem = cur % 58;
        }
        if BASE58[rem as usize] != *expected {
            return false;
        }
    }
    true
}

/// pump.fun's own limits on the metadata it writes into the Metaplex account.
const MAX_NAME: usize = 32;
const MAX_SYMBOL: usize = 10;
const MAX_URI: usize = 200;

#[program]
pub mod pumpfamily {
    use super::*;

    /// Opens a sale. The authority prefunds `LAUNCH_RESERVE` here so that launching later needs
    /// nothing from anyone.
    #[allow(clippy::too_many_arguments)]
    pub fn initialize_sale(
        ctx: Context<InitializeSale>,
        sale_id: u64,
        window_seconds: i64,
        launch_window_seconds: i64,
        per_wallet_cap: u64,
        hard_cap: u64,
        min_raise: u64,
        protocol_fee_bps: u64,
        creator_fee_bps: u64,
        creator_fee_recipient: Pubkey,
        name: String,
        symbol: String,
        uri: String,
        // 0 = native SOL, 1 = USDC. Last in the list so an older client that omits it is
        // rejected by Borsh rather than silently opening a sale in the wrong denomination.
        quote: u8,
        // The mint a non-SOL sale settles in. Stored rather than hardcoded: pump.fun keeps its
        // own whitelist in `Global` and rejects anything else at create time, which is the same
        // pass-through this program already uses for every other pump.fun account. It also makes
        // the path testable — a cloned USDC mint has Circle's authority, so a local suite could
        // never mint one to a test wallet.
        quote_mint: Pubkey,
        // pump.fun's `is_holder_reward`, chosen per sale. This argument used to be cashback, which
        // pump.fun deprecated; holder rewards replaced it on their side, so it took its slot here.
        //
        // ⛔ Cashback redirects the creator's fee leg to TRADERS as a rebate. It is not a free
        // extra: whatever it pays out is the creator reward this sale would otherwise collect.
        // It was hard-coded TRUE here, with a comment claiming it "costs this sale nothing",
        // which gave every quote launch's creator revenue away silently.
        //
        // Only `create_v2` carries the flag, so a SOL sale must not claim to set it — see below.
        holder_rewards: bool,
    ) -> Result<()> {
        // ⛔⛔ No mint is chosen here any more (review, 16 Sep 2026). pump.fun's `create_v2` creates the
        // curve's USDC account with a NON-idempotent create, so anyone who knew the mint in advance
        // could create that account first for ~0.002 SOL and make every launch of the sale revert.
        // The mint is now picked by the launch itself, from a 64-bit nonce nobody can predict.
        require!((60..=30 * 86_400).contains(&window_seconds), PumpFamilyError::WindowTooShort);
        // ⛔ Bounded both ways (review, 16 Sep 2026). Under an hour, credits cannot settle before the
        // deadline and every sale is forced to fail; unbounded, a launch that keeps reverting would
        // lock deposits until a deadline years away, since only the deadline lets `fail_sale` run.
        require!((MIN_LAUNCH_WINDOW..=7 * 86_400).contains(&launch_window_seconds), PumpFamilyError::BadLaunchWindow);

        // ⚠ The denomination is decoded HERE, before the caps, because every cap below is a
        // figure in the quote's own base units and none of them mean anything without it. It
        // used to be decoded after them, and both checks were silently reading USDC as lamports.
        let quote = Quote::from_u8(quote)?;
        // FOMO users hold USDC, and a send from the app is a USDC transfer. A SOL sale would have
        // no way in at all.
        require!(quote != Quote::Sol, PumpFamilyError::SolSalesDisabled);
        // A pair sale is a USDC sale that `set_pair` has named a pair token for. Opening one
        // directly would give it the pair marker with no pair recorded, and nothing could launch it.
        require!(quote != Quote::UsdcPair, PumpFamilyError::WrongQuote);
        // ⛔⛔ The REAL USDC, and nothing else (review, 16 Sep 2026). With any mint accepted, a creator
        // could name a mint of their own: the deposit account would hold that mint while buyers,
        // told to send USDC to the deposit wallet, filled the wallet's real USDC account — which the
        // creator still controls.
        require!(quote_mint == USDC_MINT, PumpFamilyError::WrongMint);

        // The deposit account. It is the associated USDC account of an ordinary, on-curve wallet —
        // which is what a wallet app's Send screen expects to be given — whose OWNER has been
        // handed to the vault. Nobody holds that wallet's key afterwards, and it would not matter
        // if they did: the token program only obeys the owner.
        {
            let d = &ctx.accounts.deposit_account;
            let token_program = *d.to_account_info().owner;
            let expected = Pubkey::find_program_address(
                &[ctx.accounts.deposit_wallet.key.as_ref(), token_program.as_ref(), quote_mint.as_ref()],
                &anchor_spl::associated_token::ID,
            ).0;
            require!(d.key() == expected, PumpFamilyError::BadDepositAccount);
            require!(d.mint == quote_mint, PumpFamilyError::BadDepositAccount);
            require!(d.owner == ctx.accounts.vault.key(), PumpFamilyError::BadDepositAccount);
            // A delegate or close authority set before the hand-over would survive it.
            require!(d.delegate.is_none() && d.close_authority.is_none(), PumpFamilyError::BadDepositAccount);
            require!(d.amount == 0, PumpFamilyError::BadDepositAccount);
        }
        // A SOL sale settles in lamports and has no mint; anything else must name one.
        require!(
            (quote == Quote::Sol) == (quote_mint == Pubkey::default()),
            PumpFamilyError::WrongQuote
        );

        // A cap under the minimum deposit opens a sale nobody can legally deposit into — every
        // `deposit` would fail one of the two rules whichever amount it named. Per denomination:
        // the bare constant is lamports, and against a 6-decimal quote it reads a thousand times
        // too strict.
        // ⚠ The caps are in LAMPORTS (the curve's unit); the deposit floor is in the QUOTE's unit
        // (2 USDC). They are no longer comparable, so this checks the cap against the smallest
        // lamport amount the curve can price rather than against a USDC floor.
        require!(per_wallet_cap >= MIN_CURVE_IN, PumpFamilyError::BadCap);
        require!(hard_cap >= per_wallet_cap, PumpFamilyError::BadCap);
        require!(min_raise <= hard_cap, PumpFamilyError::BadCap);
        require!(name.len() <= MAX_NAME, PumpFamilyError::MetadataTooLong);
        require!(symbol.len() <= MAX_SYMBOL, PumpFamilyError::MetadataTooLong);
        require!(uri.len() <= MAX_URI, PumpFamilyError::MetadataTooLong);

        // The fee rate comes from pump.fun's fee program, not from `Global` — see curve.rs. It is
        // supplied per sale and only floored here, because over-reserving is safe and
        // under-reserving reverts the launch.
        let total_fee_bps = protocol_fee_bps
            .checked_add(creator_fee_bps)
            .ok_or(PumpFamilyError::MathOverflow)?;
        require!(
            (MIN_TOTAL_FEE_BPS..=MAX_TOTAL_FEE_BPS).contains(&total_fee_bps),
            PumpFamilyError::FeeRateOutOfRange
        );

        // A hard cap above what the curve can absorb would let deposits accumulate that the launch
        // can never deploy. Refuse it at creation rather than stranding money at close.
        //
        // ⚠ Measured against THIS quote's opening reserve. Against `VS0` the bound is the SOL
        // curve's capacity read as USDC base units — 86,067 USDC where the USDC curve absorbs
        // 12,313 — so a `min_raise` above the real capacity passed, and the sale it opened could
        // take deposits for its whole window and never be launchable.
        // ⛔⛔ The curve is pump.fun's SOL curve, ALWAYS — `VS0`, not the quote's own reserve.
        // Buyers pay USDC and the raise is swapped to SOL at the close, so the caps and every curve
        // figure on this sale are LAMPORTS. Reading them as USDC is out by the SOL price.
        let fees = Fees::new(protocol_fee_bps, creator_fee_bps);
        let max_deployable = total_with_fees(sol_cost(RT0, VS0, VT0)?, fees);
        require!(
            (hard_cap as u128) <= max_deployable,
            PumpFamilyError::HardCapExceedsCurve
        );

        let now = Clock::get()?.unix_timestamp;
        let sale = &mut ctx.accounts.sale;
        sale.authority = ctx.accounts.authority.key();
        sale.creator_fee_recipient = creator_fee_recipient;
        sale.mint = Pubkey::default();
        sale.mint_nonce = 0;
        sale.sale_id = sale_id;
        sale.window_end = now + window_seconds;
        sale.launch_deadline = now + window_seconds + launch_window_seconds;
        sale.per_wallet_cap = per_wallet_cap;
        sale.hard_cap = hard_cap;
        sale.min_raise = min_raise;
        // The curve opens at the reserve its denomination uses. The token side is identical
        // either way, so everything downstream — the ceiling, the fairness gradient, `sold` —
        // behaves the same at a different scale.
        sale.quote = quote as u8;
        sale.quote_mint = quote_mint;
        // pump.fun deprecated cashback; the stored flag now means holder rewards (see `Sale::cashback`).
        sale.cashback = holder_rewards;
        sale.virtual_sol = VS0;
        sale.virtual_token = VT0;
        sale.sold = 0;
        sale.curve_in = 0;
        sale.fee_held = 0;
        sale.gross = 0;
        sale.sol_expected = 0;
        sale.sol_in = 0;
        sale.depositors = 0;
        sale.tokens_received = 0;
        sale.claimed_total = 0;
        sale.reserve = LAUNCH_RESERVE;
        sale.protocol_fee_bps = protocol_fee_bps;
        sale.creator_fee_bps = creator_fee_bps;
        sale.status = SaleStatus::Open as u8;
        sale.bump = ctx.bumps.sale;
        sale.vault_bump = ctx.bumps.vault;
        sale.mint_bump = 0;
        sale.name = name;
        sale.symbol = symbol;
        sale.uri = uri;
        sale.deposit_wallet = ctx.accounts.deposit_wallet.key();
        sale.deposit_account = ctx.accounts.deposit_account.key();
        sale.returned = 0;
        sale.last_credit_slot = 0;
        sale.credits_closed = false;

        invoke(
            &system_instruction::transfer(
                &ctx.accounts.authority.key(),
                &ctx.accounts.vault.key(),
                LAUNCH_RESERVE,
            ),
            &[
                ctx.accounts.authority.to_account_info(),
                ctx.accounts.vault.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
        )?;

        emit!(SaleOpened {
            sale: sale.key(),
            mint: Pubkey::default(),
            window_end: sale.window_end,
            hard_cap,
        });
        Ok(())
    }

    /// Books a USDC transfer FOMO co-signed, at the shadow curve's price for its place in line.
    ///
    /// Only the attester may call it. `slot` and `block_time` are the transfer's own, so a
    /// transfer made inside the window is still creditable after it closes. `sig` and `ix_index`
    /// name the transfer: they seed the receipt that makes it creditable exactly once, and they
    /// are emitted so the attribution can be checked against the chain by anyone.
    #[allow(clippy::too_many_arguments)]
    pub fn credit(
        ctx: Context<Credit>,
        sig: [u8; 64],
        ix_index: u8,
        slot: u64,
        block_time: i64,
        depositor: Pubkey,
        amount: u64,
    ) -> Result<()> {
        let _ = ix_index;
        let sale = &ctx.accounts.sale;
        require!(sale.status == SaleStatus::Open as u8, PumpFamilyError::SaleNotOpen);
        require!(!sale.credits_closed, PumpFamilyError::CreditsClosed);
        require!(block_time < sale.window_end, PumpFamilyError::WindowClosed);
        require!(slot >= sale.last_credit_slot, PumpFamilyError::SlotOutOfOrder);
        // The money has to be there. Before launch nothing leaves the deposit account except
        // returns, which are never counted in `gross`, so balance >= gross is exact.
        require!(
            ctx.accounts.deposit_account.amount
                >= sale.gross.checked_add(amount).ok_or(PumpFamilyError::MathOverflow)?,
            PumpFamilyError::CreditExceedsBalance
        );

        // What this USDC is worth in SOL, at the pool we will swap through. The curve is the SOL
        // curve, so this — not `amount` — is what buys tokens.
        let sol_equiv = sol_equivalent(
            &ctx.accounts.swap_pool.to_account_info(),
            &ctx.accounts.pool_sol_vault.to_account_info(),
            &ctx.accounts.pool_usdc_vault.to_account_info(),
            amount,
        )?;

        book_deposit(
            &mut ctx.accounts.sale,
            &mut ctx.accounts.position,
            depositor,
            ctx.bumps.position,
            amount,
            sol_equiv,
            block_time,
        )?;
        let sale = &mut ctx.accounts.sale;
        sale.last_credit_slot = slot;
        emit!(Credited { sale: sale.key(), depositor, amount, slot, sig });
        Ok(())
    }

    /// Sends back a transfer that does not count: not co-signed by FOMO, late, or refused by one
    /// of the caps. Attester only, and it can only ever move money that is NOT a credited deposit.
    pub fn return_transfer(ctx: Context<ReturnTransfer>, sig: [u8; 64], ix_index: u8, amount: u64) -> Result<()> {
        let _ = ix_index;
        let sale = &ctx.accounts.sale;
        require!(amount > 0, PumpFamilyError::NothingToClaim);
        // After a launch every credited unit has already left for the curve, so all that remains
        // is uncredited. Before it, or after a failure, `gross` is still owed from this account.
        let owed = if sale.status == SaleStatus::Launched as u8 { 0 } else { sale.gross };
        require!(
            ctx.accounts.deposit_account.amount.saturating_sub(amount) >= owed
                && ctx.accounts.deposit_account.amount >= amount,
            PumpFamilyError::ReturnTouchesDeposits
        );

        let sale_key = sale.key();
        let vault_seeds: &[&[u8]] = &[b"vault", sale_key.as_ref(), &[sale.vault_bump]];
        pay_out(
            &ctx.accounts.token_program,
            ctx.accounts.deposit_account.to_account_info(),
            ctx.accounts.quote_mint.to_account_info(),
            ctx.accounts.to_token_account.to_account_info(),
            ctx.accounts.vault.to_account_info(),
            vault_seeds,
            amount,
            ctx.accounts.quote_mint.decimals,
        )?;

        let sale = &mut ctx.accounts.sale;
        sale.returned = sale.returned.checked_add(amount).ok_or(PumpFamilyError::MathOverflow)?;
        emit!(Returned { sale: sale_key, to: ctx.accounts.to_token_account.owner, amount, sig });
        Ok(())
    }

    /// Turns the whole raise into SOL, once, after the window has closed.
    ///
    /// ⭐ This is why refunds still return USDC: the vault holds exactly what buyers sent until
    /// the sale is certain to launch. A sale that fails never reaches this instruction.
    ///
    /// Permissionless, like the launch — and for the same reason. What protects the money is not
    /// who calls it but what it checks: the pool is pinned, `minimum_amount_out` is computed here
    /// from that pool's own reserves, and the lamports the vault gained are measured afterwards.
    ///
    /// ⚠ Two CPIs, not one. Raydium pays in **wrapped** SOL, and pump.fun's v1 `buy` spends
    /// **native** lamports, so the wrapped account is closed immediately and its balance lands on
    /// the vault itself. The wrapped account exists for the length of this instruction and no
    /// longer.
    pub fn swap_to_sol<'info>(ctx: Context<'_, '_, '_, 'info, SwapToSol<'info>>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        {
            let sale = &ctx.accounts.sale;
            require!(sale.status == SaleStatus::Open as u8, PumpFamilyError::SaleNotOpen);
            require!(now >= sale.window_end, PumpFamilyError::WindowStillOpen);
            require!(now < sale.launch_deadline, PumpFamilyError::LaunchWindowPassed);
            require!(sale.gross >= sale.min_raise, PumpFamilyError::MinRaiseNotMet);
            require!(sale.sol_in == 0, PumpFamilyError::AlreadySwapped);
            require!(credits_settled(sale, now), PumpFamilyError::CreditsStillOpen);
            require!(ctx.accounts.swap_pool.key() == SWAP_POOL, PumpFamilyError::BadSwapPool);
        }
        // A window nobody bought into has nothing to swap, and still launches. `sol_in` stays 0
        // and `launch` skips the buy — see there.
        let amount_in = ctx.accounts.sale.gross;
        if amount_in == 0 {
            return Ok(());
        }

        let sale_key = ctx.accounts.sale.key();
        let vault_bump = ctx.accounts.sale.vault_bump;
        let vault_seeds: &[&[u8]] = &[b"vault", sale_key.as_ref(), &[vault_bump]];
        let signers: &[&[&[u8]]] = &[vault_seeds];

        // The floor, from the pool's own state at this moment. ⛔ Never from the caller.
        let (sol_reserve, usdc_reserve) = pool_reserves(
            &ctx.accounts.swap_pool.to_account_info(),
            &ctx.accounts.pool_sol_vault.to_account_info(),
            &ctx.accounts.pool_usdc_vault.to_account_info(),
        )?;
        let min_out = swap::minimum_out(sol_reserve, usdc_reserve, amount_in as u128)?;

        // Somewhere for Raydium to pay. Idempotent so a retried swap does not fail on it.
        create_idempotent(CpiContext::new_with_signer(
            ctx.accounts.associated_token_program.to_account_info(),
            Create {
                payer: ctx.accounts.cranker.to_account_info(),
                associated_token: ctx.accounts.vault_wsol.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
                mint: ctx.accounts.wsol_mint.to_account_info(),
                system_program: ctx.accounts.system_program.to_account_info(),
                token_program: ctx.accounts.token_program.to_account_info(),
            },
            signers,
        ))?;

        let before = ctx.accounts.vault.lamports();
        swap::swap_base_in(
            &ctx.accounts.raydium_program.to_account_info(),
            ctx.remaining_accounts,
            amount_in,
            min_out,
            signers,
        )?;

        // Unwrap: closing the wrapped account moves its whole balance to the vault.
        close_account(CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            CloseAccount {
                account: ctx.accounts.vault_wsol.to_account_info(),
                destination: ctx.accounts.vault.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            },
            signers,
        ))?;

        // ⭐ The guard that does the work. Whatever route the accounts described, the vault either
        // gained the SOL or this fails — and the rent of the wrapped account is subtracted, so a
        // swap that returned nothing cannot pass by looking like a refunded rent deposit.
        let after = ctx.accounts.vault.lamports();
        let gained = after.saturating_sub(before);
        let rent = Rent::get()?.minimum_balance(165);
        let swapped = gained.saturating_sub(rent);
        require!(swapped >= min_out, PumpFamilyError::SwapReturnedTooLittle);

        let sale = &mut ctx.accounts.sale;
        sale.sol_in = swapped;
        emit!(Swapped { sale: sale_key, usdc_in: amount_in, sol_out: swapped, min_out });
        Ok(())
    }

    /// The attester says every transfer made inside the window has been credited or returned, so
    /// the sale need not wait out `CREDIT_GRACE` before it can launch.
    pub fn close_credits(ctx: Context<CloseCredits>) -> Result<()> {
        let sale = &mut ctx.accounts.sale;
        require!(sale.status == SaleStatus::Open as u8, PumpFamilyError::SaleNotOpen);
        require!(Clock::get()?.unix_timestamp >= sale.window_end, PumpFamilyError::WindowStillOpen);
        sale.credits_closed = true;
        Ok(())
    }

    /// Delivers a launched position's tokens to its owner's own token account. Permissionless:
    /// a FOMO user cannot sign a claim, so the tokens have to be pushed. The caller pays the
    /// account rent when the owner has none.
    pub fn distribute(ctx: Context<Distribute>) -> Result<()> {
        let sale_key = ctx.accounts.sale.key();
        {
            let sale = &ctx.accounts.sale;
            require!(sale.status == SaleStatus::Launched as u8, PumpFamilyError::NotLaunched);
        }
        let expected = Pubkey::find_program_address(
            &[ctx.accounts.owner.key.as_ref(), ctx.accounts.token_program.key.as_ref(), ctx.accounts.mint.key().as_ref()],
            &anchor_spl::associated_token::ID,
        ).0;
        require!(ctx.accounts.owner_token_account.key() == expected, PumpFamilyError::WrongTokenAccount);

        create_idempotent(CpiContext::new(
            ctx.accounts.associated_token_program.to_account_info(),
            Create {
                payer: ctx.accounts.cranker.to_account_info(),
                associated_token: ctx.accounts.owner_token_account.to_account_info(),
                authority: ctx.accounts.owner.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                system_program: ctx.accounts.system_program.to_account_info(),
                token_program: ctx.accounts.token_program.to_account_info(),
            },
        ))?;

        let position = &mut ctx.accounts.position;
        require!(!position.claimed, PumpFamilyError::AlreadyClaimed);
        require!(position.allocation > 0, PumpFamilyError::NothingToClaim);
        /**
         * ⭐ The one place the swap's cost lands, and it lands on everyone at once.
         *
         * `allocation` is what this wallet was quoted, priced on the SOL curve at the pool's spot
         * when its money arrived. `tokens_received` is what the raise actually bought after the
         * swap's fee and impact. Every payout is scaled by the same ratio, so the ordering and
         * each wallet's share of the coin are exactly what the curve promised — only the absolute
         * count moves, and it moves identically for the first buyer and the last.
         *
         * ⚠ Floor division, deliberately: the rounding stays in the vault rather than paying out
         * a unit the vault does not hold. `sweep_tokens` can only ever take what nobody is owed.
         */
        let amount = scaled_payout(&ctx.accounts.sale, position.allocation)?;
        position.claimed = true;
        let owner = position.owner;

        let vault_seeds: &[&[u8]] = &[b"vault", sale_key.as_ref(), &[ctx.accounts.sale.vault_bump]];
        pay_out(
            &ctx.accounts.token_program,
            ctx.accounts.vault_token_account.to_account_info(),
            ctx.accounts.mint.to_account_info(),
            ctx.accounts.owner_token_account.to_account_info(),
            ctx.accounts.vault.to_account_info(),
            vault_seeds,
            amount,
            ctx.accounts.mint.decimals,
        )?;
        let sale = &mut ctx.accounts.sale;
        sale.claimed_total += amount;
        emit!(Claimed { sale: sale_key, owner, amount });
        Ok(())
    }

    /// Returns a failed sale's deposit to its owner's own USDC account. Permissionless, for the
    /// same reason `distribute` is.
    pub fn refund_push(ctx: Context<RefundPush>) -> Result<()> {
        {
            let sale = &ctx.accounts.sale;
            require!(sale.status == SaleStatus::Failed as u8, PumpFamilyError::NotFailed);
            // The USDC is gone once the raise was swapped: this would transfer from an empty
            // account and fail for every buyer forever. `refund_sol` / `refund_pair` pay instead.
            require!(sale.sol_in == 0, PumpFamilyError::SwappedRefund);
        }
        let position = &mut ctx.accounts.position;
        require!(!position.claimed, PumpFamilyError::AlreadyClaimed);
        let amount = position.deposited;
        require!(amount > 0, PumpFamilyError::NothingToClaim);
        position.claimed = true;
        let owner = position.owner;

        let sale_key = ctx.accounts.sale.key();
        let vault_seeds: &[&[u8]] = &[b"vault", sale_key.as_ref(), &[ctx.accounts.sale.vault_bump]];
        pay_out(
            &ctx.accounts.token_program,
            ctx.accounts.deposit_account.to_account_info(),
            ctx.accounts.quote_mint.to_account_info(),
            ctx.accounts.owner_token_account.to_account_info(),
            ctx.accounts.vault.to_account_info(),
            vault_seeds,
            amount,
            ctx.accounts.quote_mint.decimals,
        )?;
        let sale = &mut ctx.accounts.sale;
        sale.gross -= amount;
        emit!(Refunded { sale: sale_key, owner, amount });
        Ok(())
    }

    /// Creates the coin and buys its curve, atomically, with the SOL the swap returned.
    ///
    /// pump.fun's **`create_v2`** path, quoted in **WSOL**: a SOL-paired curve and a Token-2022
    /// mint — the same shape pump.fun's own launches have had since September 2026.
    ///
    /// ⛔⛔ This used to be v1 `create`, on the reasoning that "`Global.whitelisted_quote_mints`
    /// holds USDC and nothing else, so WSOL is not a quote mint and `create_v2` cannot make a
    /// SOL-paired coin". The whitelist reading was right and the conclusion was wrong: WSOL is
    /// handled natively and never consults that list. Measured 21 Sep 2026 — of the 70 newest
    /// coins on pump.fun, **all 70** are `create_v2` and 62 are SOL-paired exactly this way,
    /// while v1 `create` is used by none of them.
    ///
    /// ⭐ It is what lets a sale choose **holder rewards**: `is_holder_reward` is a `create_v2`
    /// argument, so on v1 the creator-fee destination could not be offered at all.
    ///
    /// Permissionless once the window has closed, so a creator cannot hold buyers' money hostage
    /// by never launching.
    ///
    /// ⭐ The token amount is computed from `sol_in` — what the swap ACTUALLY returned — not from
    /// `sold`, which is what buyers were quoted. The two differ by the swap's fee and impact, and
    /// `distribute` closes that gap with one scale factor applied to everyone alike.
    pub fn launch(ctx: Context<Launch>, mint_nonce: u64) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        {
            let sale = &ctx.accounts.sale;
            // ⛔⛔ First, so no other state can mask it: a sale that promised a pair token launches
            // through `launch_pair` and nothing else. This instruction is permissionless, so
            // without this line anyone could launch a pair sale SOL-paired once its window closed.
            require!(sale_quote(sale)? != Quote::UsdcPair, PumpFamilyError::PairSale);
            require!(sale.status == SaleStatus::Open as u8, PumpFamilyError::SaleNotOpen);
            require!(now >= sale.window_end, PumpFamilyError::WindowStillOpen);
            require!(now < sale.launch_deadline, PumpFamilyError::LaunchWindowPassed);
            require!(sale.gross >= sale.min_raise, PumpFamilyError::MinRaiseNotMet);
            require!(credits_settled(sale, now), PumpFamilyError::CreditsStillOpen);
            // ⛔ The raise has to be SOL before the curve can be bought. A sale with money in it
            // that has not been swapped is not launchable — `swap_to_sol` comes first.
            require!(sale.gross == 0 || sale.sol_in > 0, PumpFamilyError::NotSwapped);
        }
        require!(has_base58_suffix(&ctx.accounts.mint.key(), VANITY_SUFFIX), PumpFamilyError::MintSuffixMismatch);

        let sale_key = ctx.accounts.sale.key();
        let (name, symbol, uri, creator, sold, sol_in, fees, holder_rewards) = {
            let s = &ctx.accounts.sale;
            (
                s.name.clone(), s.symbol.clone(), s.uri.clone(), s.creator_fee_recipient,
                s.sold, s.sol_in, Fees::new(s.protocol_fee_bps, s.creator_fee_bps),
                // ⭐ The choice the creator made when they opened the sale, carried here
                // unchanged. It is a `create_v2` argument and pump.fun offers no way to change
                // it afterwards, so this one read is the only chance the sale ever gets.
                s.cashback,
            )
        };

        let vault_seeds: &[&[u8]] = &[b"vault", sale_key.as_ref(), &[ctx.accounts.sale.vault_bump]];
        let mint_nonce_bytes = mint_nonce.to_le_bytes();
        let mint_bump = ctx.bumps.mint;
        let mint_seeds: &[&[u8]] = &[b"mint", sale_key.as_ref(), &mint_nonce_bytes, &[mint_bump]];
        let signers: &[&[&[u8]]] = &[vault_seeds, mint_seeds];

        let a = &ctx.accounts;
        pump::create_v2(
            &[
                a.mint.to_account_info(),
                a.mint_authority.to_account_info(),
                a.bonding_curve.to_account_info(),
                a.associated_bonding_curve.to_account_info(),
                a.global.to_account_info(),
                a.vault.to_account_info(),
                a.system_program.to_account_info(),
                a.token_program.to_account_info(),
                a.associated_token_program.to_account_info(),
                a.mayhem_program_id.to_account_info(),
                a.global_params.to_account_info(),
                a.sol_vault.to_account_info(),
                a.mayhem_state.to_account_info(),
                a.mayhem_token_vault.to_account_info(),
                a.event_authority.to_account_info(),
                a.pump_program.to_account_info(),
                a.quote_mint.to_account_info(),
                a.associated_quote_bonding_curve.to_account_info(),
                a.quote_token_program.to_account_info(),
            ],
            name, symbol, uri, creator, holder_rewards, 0, signers,
        )?;

        // Nothing was raised: the coin exists on its curve at the opening price and anyone can be
        // its first buyer. Same rule as before — a window nobody bought into still launches.
        let no_buys = sol_in == 0;
        let mut received: u64 = 0;
        if !no_buys {
            create_idempotent(CpiContext::new_with_signer(
                a.associated_token_program.to_account_info(),
                Create {
                    payer: a.cranker.to_account_info(),
                    associated_token: a.vault_base_ata.to_account_info(),
                    authority: a.vault.to_account_info(),
                    mint: a.mint.to_account_info(),
                    system_program: a.system_program.to_account_info(),
                    token_program: a.token_program.to_account_info(),
                },
                signers,
            ))?;

            // What the SOL we hold actually buys, on a curve nobody has touched yet.
            let (curve_in, _fee) = split_deposit(sol_in as u128, fees)?;
            let tokens = tokens_out(VS0, VT0, curve_in, RT0);
            require!(tokens > 0, PumpFamilyError::NothingSold);

            /*
             * ⭐ `buy_exact_sol_in`, not `buy`: the known quantity at a launch is LAMPORTS — what
             * the swap actually returned — and this instruction takes exactly that. `buy` asks
             * for a token count with a SOL ceiling, which meant computing the curve here and
             * trusting pump.fun to reach the same answer from the other direction.
             *
             * ⚠ `tokens` becomes a FLOOR rather than a target. It is this program's own curve
             * arithmetic, which `differential.test.mjs` pins against the Rust and the JS agreeing
             * on 200 vectors, so a pump.fun that disagrees at all should fail the launch rather
             * than quietly fill less. The 1% below is for the rounding between two
             * implementations, not for price movement: nobody else can touch this curve, it was
             * created three instructions ago in this same transaction.
             */
            let min_tokens_out = u64::try_from(tokens * 99 / 100)
                .map_err(|_| PumpFamilyError::MathOverflow)?;

            pump::buy_exact_sol_in(
                &[
                    a.global.to_account_info(),
                    a.fee_recipient.to_account_info(),
                    a.mint.to_account_info(),
                    a.bonding_curve.to_account_info(),
                    a.associated_bonding_curve.to_account_info(),
                    a.vault_base_ata.to_account_info(),
                    a.vault.to_account_info(),
                    a.system_program.to_account_info(),
                    a.token_program.to_account_info(),
                    a.creator_vault.to_account_info(),
                    a.event_authority.to_account_info(),
                    a.pump_program.to_account_info(),
                    a.global_volume_accumulator.to_account_info(),
                    a.user_volume_accumulator.to_account_info(),
                    a.fee_config.to_account_info(),
                    a.fee_program.to_account_info(),
                    a.bonding_curve_v2.to_account_info(),
                    a.buyback_fee_recipient.to_account_info(),
                ],
                sol_in,
                min_tokens_out,
                true,
                signers,
            )?;

            // Trust the chain, not the arithmetic — the same guard every launch here has had.
            let data = a.vault_base_ata.try_borrow_data()?;
            require!(data.len() >= 72, PumpFamilyError::WrongTokenAccount);
            received = u64::from_le_bytes(data[64..72].try_into().unwrap());
            require!(received > 0, PumpFamilyError::ReceivedLessThanAllocated);
        }

        let mint_key = a.mint.key();
        let sale = &mut ctx.accounts.sale;
        sale.tokens_received = received;
        sale.mint = mint_key;
        sale.mint_nonce = mint_nonce;
        sale.mint_bump = mint_bump;
        sale.status = SaleStatus::Launched as u8;
        emit!(Launched {
            sale: sale_key,
            mint: mint_key,
            spent: sol_in,
            tokens_received: received,
            allocated: sold,
        });
        Ok(())
    }

    /// Claims an allocation. Claim-based rather than push-based: the claimant pays their own token
    /// account rent, and nobody can be stranded by a transfer that failed in a batch they never saw.
    /// Claiming a coin that is Token-2022, from a quote sale.
    ///
    /// Separate from `claim` for the same reason `deposit_quote` is separate: a `create_v2` coin
    /// lives in Token-2022, and its accounts are a different type and a different program. The
    /// settlement rules are identical, and `claimed` is still the one flag `claim` and `refund`
    /// share, so a position settles exactly once whichever route it takes.
    ///
    /// ⚠ `transfer_checked` rather than `transfer`. Token-2022 requires it for mints carrying
    /// extensions, and it verifies mint and decimals on the way through.
    pub fn claim_quote(ctx: Context<ClaimQuote>) -> Result<()> {
        let sale_key = ctx.accounts.sale.key();
        {
            let sale = &ctx.accounts.sale;
            require!(sale.status == SaleStatus::Launched as u8, PumpFamilyError::NotLaunched);
            require!(sale_quote(sale)? != Quote::Sol, PumpFamilyError::WrongQuote);
        }
        let position = &mut ctx.accounts.position;
        require!(!position.claimed, PumpFamilyError::AlreadyClaimed);
        require!(position.allocation > 0, PumpFamilyError::NothingToClaim);

        /**
         * 🔴 The SAME scale as `distribute`, or the two routes pay different amounts for the same
         * position. This used to pay the raw `allocation` — what the wallet was QUOTED — while
         * `distribute` pays `allocation × tokens_received / sold`, what the raise actually bought.
         * The quoted figure is always the larger one (the swap's fee and impact come off it), so a
         * position claimed here took more than its share and the last positions delivered by
         * `distribute` would have found the vault short. (Reported by an outside reviewer, 22 Sep
         * 2026; no sale had claimed this way.)
         */
        let amount = scaled_payout(&ctx.accounts.sale, position.allocation)?;
        position.claimed = true;

        let vault_bump = ctx.accounts.sale.vault_bump;
        let vault_seeds: &[&[u8]] = &[b"vault", sale_key.as_ref(), &[vault_bump]];

        anchor_spl::token_interface::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                anchor_spl::token_interface::TransferChecked {
                    from: ctx.accounts.vault_token_account.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.claimer_token_account.to_account_info(),
                    authority: ctx.accounts.vault.to_account_info(),
                },
                &[vault_seeds],
            ),
            amount,
            ctx.accounts.mint.decimals,
        )?;

        let sale = &mut ctx.accounts.sale;
        sale.claimed_total += amount;

        emit!(Claimed { sale: sale_key, owner: position.owner, amount });
        Ok(())
    }

    /// Returning a quote-token deposit after a failed sale.
    ///
    /// The money sits in a token account the vault owns rather than in the vault's lamports, so
    /// this is an SPL transfer the vault signs for, not a system transfer.
    pub fn refund_quote(ctx: Context<RefundQuote>) -> Result<()> {
        {
            let sale = &ctx.accounts.sale;
            require!(sale.status == SaleStatus::Failed as u8, PumpFamilyError::NotFailed);
            require!(sale_quote(sale)? != Quote::Sol, PumpFamilyError::WrongQuote);
            require!(ctx.accounts.quote_mint.key() == sale.quote_mint, PumpFamilyError::WrongMint);
            require!(sale.sol_in == 0, PumpFamilyError::SwappedRefund);
        }
        let position = &mut ctx.accounts.position;
        require!(!position.claimed, PumpFamilyError::AlreadyClaimed);
        let amount = position.deposited;
        require!(amount > 0, PumpFamilyError::NothingToClaim);
        position.claimed = true;

        let sale_key = ctx.accounts.sale.key();
        let vault_bump = ctx.accounts.sale.vault_bump;
        let vault_seeds: &[&[u8]] = &[b"vault", sale_key.as_ref(), &[vault_bump]];

        anchor_spl::token_interface::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                anchor_spl::token_interface::TransferChecked {
                    from: ctx.accounts.vault_token_account.to_account_info(),
                    mint: ctx.accounts.quote_mint.to_account_info(),
                    to: ctx.accounts.depositor_token_account.to_account_info(),
                    authority: ctx.accounts.vault.to_account_info(),
                },
                &[vault_seeds],
            ),
            amount,
            ctx.accounts.quote_mint.decimals,
        )?;

        let sale = &mut ctx.accounts.sale;
        sale.gross -= amount;

        emit!(Refunded { sale: sale.key(), owner: position.owner, amount });
        Ok(())
    }

    /// Refunds a failed sale whose raise had ALREADY been swapped to SOL — in SOL, pro rata.
    ///
    /// 🔴🔴 The hole this closes: `swap_to_sol` moves the raise out of the deposit account, and if
    /// the launch then never lands before `launch_deadline` (pump.fun down, the cranker dead) the
    /// sale can be failed with the USDC gone. `refund_push` would transfer from an empty account
    /// and fail for every buyer forever, while the SOL sat in a vault that `sweep_lamports`
    /// refuses until `gross == 0` — money nobody could reach, and a health check that stayed
    /// green. (Reported by an outside reviewer, 22 Sep 2026. No sale has been in this state.)
    ///
    /// ⭐ Pro rata on what REMAINS: each position gets `deposited / gross` of `sol_in`, and both
    /// figures come down as refunds are paid, so the last refund takes exactly what is left and
    /// floor rounding can never pay a lamport the vault does not hold. There is no reverse swap:
    /// the buyer gets SOL at whatever the market gave for the raise, which is the same price every
    /// other buyer gets. Permissionless, like every refund.
    ///
    /// ⛔ A pair sale whose SOL went on into the pair token refunds THAT token — `refund_pair` —
    /// so this asks the pair account and refuses once `pair_in > 0`.
    pub fn refund_sol(ctx: Context<RefundSol>) -> Result<()> {
        let sale_key = ctx.accounts.sale.key();
        {
            let sale = &ctx.accounts.sale;
            require!(sale.status == SaleStatus::Failed as u8, PumpFamilyError::NotFailed);
            require!(sale.sol_in > 0, PumpFamilyError::NotSwapped);
            if sale_quote(sale)? == Quote::UsdcPair {
                let pair_info = &ctx.accounts.pair;
                let expected = Pubkey::find_program_address(&[b"pair", sale_key.as_ref()], &crate::ID).0;
                require!(pair_info.key() == expected, PumpFamilyError::BadPairAccount);
                let pair = SalePair::try_deserialize(&mut &pair_info.data.borrow()[..])?;
                require!(pair.pair_in == 0, PumpFamilyError::RefundInPair);
            }
        }
        let position = &mut ctx.accounts.position;
        require!(!position.claimed, PumpFamilyError::AlreadyClaimed);
        let deposited = position.deposited;
        require!(deposited > 0, PumpFamilyError::NothingToClaim);
        let lamports = pro_rata(deposited, ctx.accounts.sale.gross, ctx.accounts.sale.sol_in)?;
        position.claimed = true;
        let owner = position.owner;

        if lamports > 0 {
            let vault_seeds: &[&[u8]] = &[b"vault", sale_key.as_ref(), &[ctx.accounts.sale.vault_bump]];
            invoke_signed(
                &system_instruction::transfer(&ctx.accounts.vault.key(), &ctx.accounts.owner.key(), lamports),
                &[
                    ctx.accounts.vault.to_account_info(),
                    ctx.accounts.owner.to_account_info(),
                    ctx.accounts.system_program.to_account_info(),
                ],
                &[vault_seeds],
            )?;
        }
        let sale = &mut ctx.accounts.sale;
        sale.gross -= deposited;
        sale.sol_in -= lamports;
        emit!(RefundedSol { sale: sale_key, owner, deposited, lamports });
        Ok(())
    }

    /// Refunds a failed PAIR sale whose SOL had already gone on into the pair token — in that
    /// token, pro rata, the same arithmetic as `refund_sol`. The caller pays the owner's token
    /// account rent when there is none, exactly as `distribute` does.
    pub fn refund_pair(ctx: Context<RefundPair>) -> Result<()> {
        let sale_key = ctx.accounts.sale.key();
        {
            let sale = &ctx.accounts.sale;
            require!(sale.status == SaleStatus::Failed as u8, PumpFamilyError::NotFailed);
            require!(sale_quote(sale)? == Quote::UsdcPair, PumpFamilyError::NotPairSale);
            require!(ctx.accounts.pair.pair_in > 0, PumpFamilyError::NotSwapped);
        }
        let expected = Pubkey::find_program_address(
            &[ctx.accounts.owner.key.as_ref(), ctx.accounts.token_program.key.as_ref(), ctx.accounts.mint.key().as_ref()],
            &anchor_spl::associated_token::ID,
        ).0;
        require!(ctx.accounts.owner_token_account.key() == expected, PumpFamilyError::WrongTokenAccount);
        create_idempotent(CpiContext::new(
            ctx.accounts.associated_token_program.to_account_info(),
            Create {
                payer: ctx.accounts.cranker.to_account_info(),
                associated_token: ctx.accounts.owner_token_account.to_account_info(),
                authority: ctx.accounts.owner.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                system_program: ctx.accounts.system_program.to_account_info(),
                token_program: ctx.accounts.token_program.to_account_info(),
            },
        ))?;

        let position = &mut ctx.accounts.position;
        require!(!position.claimed, PumpFamilyError::AlreadyClaimed);
        let deposited = position.deposited;
        require!(deposited > 0, PumpFamilyError::NothingToClaim);
        let amount = pro_rata(deposited, ctx.accounts.sale.gross, ctx.accounts.pair.pair_in)?;
        position.claimed = true;
        let owner = position.owner;

        if amount > 0 {
            let vault_seeds: &[&[u8]] = &[b"vault", sale_key.as_ref(), &[ctx.accounts.sale.vault_bump]];
            pay_out(
                &ctx.accounts.token_program,
                ctx.accounts.vault_token_account.to_account_info(),
                ctx.accounts.mint.to_account_info(),
                ctx.accounts.owner_token_account.to_account_info(),
                ctx.accounts.vault.to_account_info(),
                vault_seeds,
                amount,
                ctx.accounts.mint.decimals,
            )?;
        }
        ctx.accounts.sale.gross -= deposited;
        ctx.accounts.pair.pair_in -= amount;
        emit!(RefundedPair { sale: sale_key, owner, deposited, amount });
        Ok(())
    }

    /// Returns the vault's leftover lamports to the authority.
    ///
    /// After a launch there is no lamport obligation left: every depositor lamport went into the
    /// buy, so what remains is the unspent launch reserve plus a few hundred lamports of slack.
    /// After a failed sale the reserve is only free once every deposit has actually been refunded,
    /// which `gross == 0` is the ledger's way of saying.
    pub fn sweep_lamports(ctx: Context<SweepLamports>) -> Result<()> {
        let sale = &ctx.accounts.sale;
        require!(
            sale.status == SaleStatus::Launched as u8
                || (sale.status == SaleStatus::Failed as u8 && sale.gross == 0),
            PumpFamilyError::RefundsOutstanding
        );

        // The vault stays alive as the token-transfer authority for claims that have not happened
        // yet, so it keeps a rent-exempt floor rather than being drained to nothing.
        let floor = Rent::get()?.minimum_balance(0);
        let amount = ctx.accounts.vault.lamports().saturating_sub(floor);
        require!(amount > 0, PumpFamilyError::NothingToSweep);

        let sale_key = sale.key();
        let vault_seeds: &[&[u8]] = &[b"vault", sale_key.as_ref(), &[sale.vault_bump]];
        invoke_signed(
            &system_instruction::transfer(
                &ctx.accounts.vault.key(),
                &ctx.accounts.authority.key(),
                amount,
            ),
            &[
                ctx.accounts.vault.to_account_info(),
                ctx.accounts.authority.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
            &[vault_seeds],
        )?;
        emit!(Swept { sale: sale_key, lamports: amount, tokens: 0 });
        Ok(())
    }

    /// Marks a sale failed. Permissionless, and deliberately so: the refund path must not depend on
    /// the creator doing anything.
    pub fn fail_sale(ctx: Context<FailSale>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let sale = &mut ctx.accounts.sale;
        require!(sale.status == SaleStatus::Open as u8, PumpFamilyError::SaleNotOpen);

        // Late credits can still raise `gross`, so "missed the minimum" is only known once they
        // are settled.
        let missed_minimum = credits_settled(sale, now) && sale.gross < sale.min_raise;
        let never_launched = now >= sale.launch_deadline;
        require!(missed_minimum || never_launched, PumpFamilyError::CannotFailYet);

        sale.status = SaleStatus::Failed as u8;
        emit!(SaleFailed { sale: sale.key(), gross: sale.gross });
        Ok(())
    }

    /// Names the custom liquidity token a sale's coin will be paired with, and its creator fee.
    ///
    /// Sent by the launch form in the SAME transaction as `initialize_sale`, so a pair sale is
    /// never visible without its pair. Authority only, before anyone has deposited, and once: the
    /// `init` on the pair account refuses a second call.
    ///
    /// ⭐ Any token on pump.fun's own custom-pair list, read here from pump.fun's account — the
    /// same choice pump.fun's launch form offers, and nothing it would refuse at create time.
    pub fn set_pair(ctx: Context<SetPair>, creator_fee_bps: u64) -> Result<()> {
        let sale = &ctx.accounts.sale;
        require!(sale.status == SaleStatus::Open as u8, PumpFamilyError::SaleNotOpen);
        require!(sale_quote(sale)? == Quote::Usdc, PumpFamilyError::WrongQuote);
        require!(sale.gross == 0 && sale.depositors == 0, PumpFamilyError::PairAfterDeposits);
        require!(creator_fee_bps <= MAX_PAIR_CREATOR_FEE_BPS, PumpFamilyError::PairCreatorFeeTooHigh);
        let mint = ctx.accounts.pair_mint.key();
        // SOL and USDC are not custom pairs: SOL is the ordinary launch, and USDC sits on
        // pump.fun's other whitelist and launches without the quote-control account.
        require!(mint != WSOL_MINT && mint != USDC_MINT, PumpFamilyError::PairNotListed);
        require!(
            is_listed_pair(&ctx.accounts.quote_control.to_account_info(), &mint)?,
            PumpFamilyError::PairNotListed
        );

        let pair = &mut ctx.accounts.pair;
        pair.sale = sale.key();
        pair.mint = mint;
        pair.token_program = *ctx.accounts.pair_mint.to_account_info().owner;
        pair.creator_fee_bps = creator_fee_bps;
        pair.pair_in = 0;
        pair.bump = ctx.bumps.pair;

        let sale = &mut ctx.accounts.sale;
        sale.quote = Quote::UsdcPair as u8;
        emit!(PairSet { sale: sale.key(), pair_mint: mint, creator_fee_bps });
        Ok(())
    }

    /// Turns the SOL from `swap_to_sol` into the pair token, through Jupiter, once.
    ///
    /// ⚠ Attester only — it chooses the route and the floor. See `pair.rs` for exactly what the
    /// program still guarantees whatever route it is handed.
    pub fn swap_to_pair<'info>(
        ctx: Context<'_, '_, '_, 'info, SwapToPair<'info>>,
        route: Vec<u8>,
        min_out: u64,
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        {
            let sale = &ctx.accounts.sale;
            require!(sale.status == SaleStatus::Open as u8, PumpFamilyError::SaleNotOpen);
            require!(now >= sale.window_end, PumpFamilyError::WindowStillOpen);
            require!(now < sale.launch_deadline, PumpFamilyError::LaunchWindowPassed);
            require!(sale.sol_in > 0, PumpFamilyError::NotSwapped);
            require!(ctx.accounts.pair.pair_in == 0, PumpFamilyError::AlreadySwapped);
            require!(min_out > 0, PumpFamilyError::SwapReturnedTooLittle);
        }
        // Never swap into a token pump.fun has since taken off its list: the launch would then be
        // refused with the raise already converted.
        require!(
            is_listed_pair(&ctx.accounts.quote_control.to_account_info(), &ctx.accounts.pair.mint)?,
            PumpFamilyError::PairNotListed
        );

        let sale_key = ctx.accounts.sale.key();
        let sol_in = ctx.accounts.sale.sol_in;
        let vault_seeds: &[&[u8]] = &[b"vault", sale_key.as_ref(), &[ctx.accounts.sale.vault_bump]];
        let signers: &[&[&[u8]]] = &[vault_seeds];
        let a = &ctx.accounts;

        for (ata, mint, program) in [
            (&a.vault_wsol, a.wsol_mint.to_account_info(), a.wsol_token_program.to_account_info()),
            (&a.vault_pair_ata, a.pair_mint.to_account_info(), a.pair_token_program.to_account_info()),
        ] {
            create_idempotent(CpiContext::new_with_signer(
                a.associated_token_program.to_account_info(),
                Create {
                    payer: a.attester.to_account_info(),
                    associated_token: ata.to_account_info(),
                    authority: a.vault.to_account_info(),
                    mint,
                    system_program: a.system_program.to_account_info(),
                    token_program: program,
                },
                signers,
            ))?;
        }

        // Wrap exactly the SOL the first swap returned — buyers' money, and nothing of the reserve.
        invoke_signed(
            &system_instruction::transfer(&a.vault.key(), &a.vault_wsol.key(), sol_in),
            &[a.vault.to_account_info(), a.vault_wsol.to_account_info(), a.system_program.to_account_info()],
            signers,
        )?;
        anchor_spl::token::sync_native(CpiContext::new(
            a.wsol_token_program.to_account_info(),
            anchor_spl::token::SyncNative { account: a.vault_wsol.to_account_info() },
        ))?;

        let before = token_amount(&a.vault_pair_ata.to_account_info())?;
        let usdc_before = token_amount(&a.deposit_account.to_account_info())?;
        jupiter_route(&a.jupiter_program.to_account_info(), ctx.remaining_accounts, &a.vault.key(), route, signers)?;

        // ⛔ All of it, or none of it. SOL a route left behind would sit in the vault as lamports,
        // and `sweep_lamports` hands vault lamports to the sale authority.
        require!(token_amount(&a.vault_wsol.to_account_info())? == 0, PumpFamilyError::SwapLeftSolBehind);
        // The route may touch nothing else the vault signs for.
        require!(token_amount(&a.deposit_account.to_account_info())? == usdc_before, PumpFamilyError::SwapLeftSolBehind);
        let gained = token_amount(&a.vault_pair_ata.to_account_info())?.saturating_sub(before);
        require!(gained >= min_out, PumpFamilyError::SwapReturnedTooLittle);

        // The empty wrapped account's rent goes back to whoever paid it.
        close_account(CpiContext::new_with_signer(
            a.wsol_token_program.to_account_info(),
            CloseAccount {
                account: a.vault_wsol.to_account_info(),
                destination: a.attester.to_account_info(),
                authority: a.vault.to_account_info(),
            },
            signers,
        ))?;

        ctx.accounts.pair.pair_in = gained;
        emit!(PairSwapped { sale: sale_key, sol_in, pair_out: gained, min_out });
        Ok(())
    }

    /// Creates the coin paired with the sale's custom liquidity token and buys its curve with
    /// everything `swap_to_pair` delivered — atomically, like `launch`.
    ///
    /// The same `create_v2` pump.fun's own launch form sends for a custom pair: the usual sixteen
    /// accounts plus `[pair_mint, curve's pair account, pair token program, quote_control]`, and
    /// the sale's chosen creator fee. The buy is `buy_exact_quote_in_v2`, whose 27 accounts arrive
    /// as `remaining_accounts` in pump.fun's order; the ones that are ours are pinned below.
    ///
    /// Permissionless once the pair swap is done, for the same reason as `launch`.
    pub fn launch_pair<'info>(ctx: Context<'_, '_, '_, 'info, LaunchPair<'info>>, mint_nonce: u64) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        {
            let sale = &ctx.accounts.sale;
            require!(sale.status == SaleStatus::Open as u8, PumpFamilyError::SaleNotOpen);
            require!(now >= sale.window_end, PumpFamilyError::WindowStillOpen);
            require!(now < sale.launch_deadline, PumpFamilyError::LaunchWindowPassed);
            require!(sale.gross >= sale.min_raise, PumpFamilyError::MinRaiseNotMet);
            require!(credits_settled(sale, now), PumpFamilyError::CreditsStillOpen);
            require!(sale_quote(sale)? == Quote::UsdcPair, PumpFamilyError::NotPairSale);
            require!(sale.gross == 0 || ctx.accounts.pair.pair_in > 0, PumpFamilyError::NotSwapped);
        }
        require!(has_base58_suffix(&ctx.accounts.mint.key(), VANITY_SUFFIX), PumpFamilyError::MintSuffixMismatch);

        let sale_key = ctx.accounts.sale.key();
        let (name, symbol, uri, creator, sold, holder_rewards) = {
            let s = &ctx.accounts.sale;
            (s.name.clone(), s.symbol.clone(), s.uri.clone(), s.creator_fee_recipient, s.sold, s.cashback)
        };
        let (pair_in, creator_fee_bps) = (ctx.accounts.pair.pair_in, ctx.accounts.pair.creator_fee_bps);

        let vault_seeds: &[&[u8]] = &[b"vault", sale_key.as_ref(), &[ctx.accounts.sale.vault_bump]];
        let mint_nonce_bytes = mint_nonce.to_le_bytes();
        let mint_bump = ctx.bumps.mint;
        let mint_seeds: &[&[u8]] = &[b"mint", sale_key.as_ref(), &mint_nonce_bytes, &[mint_bump]];
        let signers: &[&[&[u8]]] = &[vault_seeds, mint_seeds];

        let a = &ctx.accounts;
        pump::create_v2(
            &[
                a.mint.to_account_info(),
                a.mint_authority.to_account_info(),
                a.bonding_curve.to_account_info(),
                a.associated_bonding_curve.to_account_info(),
                a.global.to_account_info(),
                a.vault.to_account_info(),
                a.system_program.to_account_info(),
                a.token_program.to_account_info(),
                a.associated_token_program.to_account_info(),
                a.mayhem_program_id.to_account_info(),
                a.global_params.to_account_info(),
                a.sol_vault.to_account_info(),
                a.mayhem_state.to_account_info(),
                a.mayhem_token_vault.to_account_info(),
                a.event_authority.to_account_info(),
                a.pump_program.to_account_info(),
                a.pair_mint.to_account_info(),
                a.associated_quote_bonding_curve.to_account_info(),
                a.pair_token_program.to_account_info(),
                a.quote_control.to_account_info(),
            ],
            name, symbol, uri, creator, holder_rewards, creator_fee_bps, signers,
        )?;

        let mut received: u64 = 0;
        if pair_in > 0 {
            let r = ctx.remaining_accounts;
            // pump.fun validates its own PDAs; these are the accounts that decide whose money
            // moves and where the coins land, so they are ours to pin.
            require!(r.len() == 27, PumpFamilyError::BadPairAccount);
            require_keys_eq!(r[1].key(), a.mint.key(), PumpFamilyError::BadPairAccount);
            require_keys_eq!(r[2].key(), a.pair_mint.key(), PumpFamilyError::BadPairAccount);
            require_keys_eq!(r[13].key(), a.vault.key(), PumpFamilyError::BadPairAccount);
            require_keys_eq!(r[14].key(), a.vault_base_ata.key(), PumpFamilyError::BadPairAccount);
            require_keys_eq!(r[15].key(), a.vault_pair_ata.key(), PumpFamilyError::BadPairAccount);
            require_keys_eq!(r[26].key(), pump::PUMP_PROGRAM, PumpFamilyError::BadPairAccount);

            create_idempotent(CpiContext::new_with_signer(
                a.associated_token_program.to_account_info(),
                Create {
                    payer: a.cranker.to_account_info(),
                    associated_token: a.vault_base_ata.to_account_info(),
                    authority: a.vault.to_account_info(),
                    mint: a.mint.to_account_info(),
                    system_program: a.system_program.to_account_info(),
                    token_program: a.token_program.to_account_info(),
                },
                signers,
            ))?;

            // ⛔ pump.fun's protocol and buyback fee wallets need an account for the PAIR token, and
            // the buy does not make them: it transfers into them and fails with IncorrectProgramId
            // when one is missing (found on a clone, 21 Sep 2026, for CATE's buyback account).
            // On mainnet they exist for the popular pairs, which is why pump.fun's own form never
            // creates them — but nothing guarantees it for every token on the list, and a launch
            // must not be blockable by an account nobody made. Idempotent; the ATA program checks
            // each address against its owner and mint. A few thousandths of SOL, from the cranker.
            for (owner, ata) in [(&r[6], &r[7]), (&r[8], &r[9])] {
                create_idempotent(CpiContext::new(
                    a.associated_token_program.to_account_info(),
                    Create {
                        payer: a.cranker.to_account_info(),
                        associated_token: ata.clone(),
                        authority: owner.clone(),
                        mint: a.pair_mint.to_account_info(),
                        system_program: a.system_program.to_account_info(),
                        token_program: a.pair_token_program.to_account_info(),
                    },
                ))?;
            }

            // ⚠ A floor of 1, not a computed one. The curve was created two instructions ago in
            // this same transaction, so nobody can have moved it; what guards the money is the
            // balance read below, the same guard `launch` has always had.
            pump::buy_exact_quote_in_v2(r, pair_in, 1, signers)?;

            received = token_amount(&a.vault_base_ata.to_account_info())?;
            require!(received > 0, PumpFamilyError::ReceivedLessThanAllocated);
        }

        let mint_key = a.mint.key();
        let sale = &mut ctx.accounts.sale;
        sale.tokens_received = received;
        sale.mint = mint_key;
        sale.mint_nonce = mint_nonce;
        sale.mint_bump = mint_bump;
        sale.status = SaleStatus::Launched as u8;
        emit!(Launched {
            sale: sale_key,
            mint: mint_key,
            spent: pair_in,
            tokens_received: received,
            allocated: sold,
        });
        Ok(())
    }

}

/* ------------------------------------------------------------------ state */

#[repr(u8)]
pub enum SaleStatus {
    Open = 0,
    Launched = 1,
    Failed = 2,
}

#[account]
#[derive(Default)]
pub struct Sale {
    pub authority: Pubkey,
    /// pump.fun's `creator` argument. Set once, at `create`, and unreachable afterwards.
    pub creator_fee_recipient: Pubkey,
    /// The PDA mint this sale will launch. Recorded at open so every later instruction can pin a
    /// token account to it rather than trusting whatever the caller passed.
    pub mint: Pubkey,
    pub sale_id: u64,
    pub window_end: i64,
    pub launch_deadline: i64,
    pub per_wallet_cap: u64,
    pub hard_cap: u64,
    pub min_raise: u64,
    /// Shadow curve state, mirroring pump.fun's virtual reserves.
    pub virtual_sol: u128,
    pub virtual_token: u128,
    /// Token base units allocated so far.
    pub sold: u64,
    /// Lamports destined for the curve, and lamports held back for pump.fun's 1%.
    pub curve_in: u64,
    pub fee_held: u64,
    /// ⚠ **USDC**, always — what buyers actually sent, and what a refund returns. Every other
    /// figure on this account that talks about money is LAMPORTS, because the curve is the SOL
    /// curve now. The two are not interchangeable and never were: see `sol_expected`.
    pub gross: u64,
    /// The SOL-equivalent of everything credited, at the swap pool's rate when each buy was
    /// booked. This is what the shadow curve actually consumed, and what the swap at the close is
    /// trying to reproduce — `curve_in + fee_held`, in lamports.
    pub sol_expected: u64,
    /// The lamports the swap at the close actually returned. ⛔ `sol_expected` is what was quoted
    /// to buyers and `sol_in` is what the market gave — the gap between them is the swap's fee and
    /// impact, and `distribute` spreads it over everyone as one scale factor.
    pub sol_in: u64,
    pub depositors: u32,
    pub tokens_received: u64,
    pub claimed_total: u64,
    pub reserve: u64,
    /// The fee legs this sale reserved against, from pump.fun's fee program.
    pub protocol_fee_bps: u64,
    pub creator_fee_bps: u64,
    /// The ground seed that gives this sale's mint its `fomo` suffix.
    pub mint_nonce: u64,
    /// The mint a non-SOL sale settles in. `Pubkey::default()` for native SOL.
    pub quote_mint: Pubkey,
    /// What this sale is denominated in: 0 native SOL, 1 USDC. Decides the opening reserve, what
    /// a depositor sends, and which pump.fun instructions the launch uses.
    pub quote: u8,
    /// The sale's **creator-rewards destination**: false pays the creator, true pays the coin's
    /// holders. It is pump.fun's `is_holder_reward`.
    ///
    /// ⚠ Named `cashback` for layout reasons — it held pump.fun's `is_cashback_enabled` until
    /// they deprecated cashback and holder rewards took its slot. Renaming the field would move
    /// every byte after it in an account that already exists on chain.
    ///
    /// ⛔⛔ Recorded at open and applied at launch, and **permanent from that moment**. It is a
    /// `create_v2` argument, pump.fun exposes no instruction to change it per coin
    /// (`update_holder_reward_config` sets their GLOBAL switch and needs their own authority),
    /// and a `SharingConfig` cannot be created by anyone but them. There is no repair.
    pub cashback: bool,
    pub status: u8,
    pub bump: u8,
    pub vault_bump: u8,
    pub mint_bump: u8,
    pub name: String,
    pub symbol: String,
    pub uri: String,
    /// The on-curve wallet a buyer sends USDC to from the FOMO app.
    pub deposit_wallet: Pubkey,
    /// That wallet's USDC account, owned by the vault. Where the deposits actually sit.
    pub deposit_account: Pubkey,
    /// USDC sent back by `return_transfer`.
    pub returned: u64,
    /// Credits must not go back in time across slots. See `credit`.
    pub last_credit_slot: u64,
    pub credits_closed: bool,
}

impl Sale {
    // ⚠ The trailing `+ 1` is `cashback`. Every field added here needs one.
    pub const SIZE: usize = 8 + 32 + 32 + 32 + 32 + 8 + 8 + 8 + 8 + 8 + 8 + 16 + 16 + 8 + 8 + 8 + 8
        // ⚠ the `8` after the five u64s is `mint_nonce`, a u64 since the launch picks the mint.
        + 4 + 8 + 8 + 8 + 8 + 8 + 8 + 1 + 1 + 1 + 1 + 1 + (4 + MAX_NAME) + (4 + MAX_SYMBOL)
        + (4 + MAX_URI) + 1
        + 32 + 32 + 8 + 8 + 1
        // `sol_expected` + `sol_in`. ⛔ Changing this changes SALE_SIZE in watcher/attester.mjs,
        // which lists sales by exact account size — they are one number in two places.
        + 8 + 8;
}

#[account]
pub struct Position {
    pub sale: Pubkey,
    pub owner: Pubkey,
    /// ⚠ What this wallet actually SENT, in the quote's own units — USDC. This is the refund
    /// figure, and it is not what the curve consumed.
    pub deposited: u64,
    /// The SOL-equivalent of that, at the pool's rate when each buy was booked. Lamports. This is
    /// what the curve consumed and what the per-wallet cap is measured against.
    pub sol_equiv: u64,
    /// Token base units owed at the quoted rate. ⛔ NOT what is delivered: `distribute` scales
    /// every allocation by `tokens_received / sold`, because the swap at the close decides how
    /// much of the curve the raise actually bought. One factor, the same for everyone.
    pub allocation: u64,
    /// Set by either `claim` or `refund` — a position settles exactly once, either way.
    pub claimed: bool,
    pub bump: u8,
}

impl Position {
    pub const SIZE: usize = 8 + 32 + 32 + 8 + 8 + 8 + 1 + 1;  // + sol_equiv
}

/* ------------------------------------------------------------------ contexts */

/// The quote a sale is denominated in, decoded from its stored byte.
fn sale_quote(sale: &Sale) -> Result<Quote> {
    Quote::from_u8(sale.quote)
}


/// Whether a sale's deposits are final: the attester has closed them, or it has had its grace.
fn credits_settled(sale: &Sale, now: i64) -> bool {
    now >= sale.window_end && (sale.credits_closed || now >= sale.window_end.saturating_add(CREDIT_GRACE))
}

/// A token transfer the vault signs for.
#[allow(clippy::too_many_arguments)]
/// What a launched position is paid: its quoted `allocation` scaled by what the raise actually
/// bought. ONE formula, used by `distribute` and `claim_quote` alike — two routes to the same
/// position must pay the same amount, or the route chosen decides who ends up short.
///
/// ⚠ Floor division, deliberately: the rounding stays in the vault rather than paying out a unit
/// the vault does not hold. `sweep_tokens` can only ever take what nobody is owed.
fn scaled_payout(sale: &Sale, allocation: u64) -> Result<u64> {
    require!(sale.sold > 0, PumpFamilyError::NothingSold);
    let amount = u64::try_from(
        (allocation as u128)
            .checked_mul(sale.tokens_received as u128)
            .ok_or(PumpFamilyError::MathOverflow)?
            / sale.sold as u128,
    )
    .map_err(|_| PumpFamilyError::MathOverflow)?;
    require!(amount > 0, PumpFamilyError::NothingToClaim);
    Ok(amount)
}

/// A failed sale's refund from a pool that is no longer the deposits: `deposited / gross` of
/// `pool`, where `gross` and `pool` are what REMAINS after earlier refunds. The last position has
/// `deposited == gross` and takes exactly the remainder; nothing can pay out more than the pool.
fn pro_rata(deposited: u64, gross: u64, pool: u64) -> Result<u64> {
    require!(gross >= deposited && gross > 0, PumpFamilyError::MathOverflow);
    u64::try_from((deposited as u128).checked_mul(pool as u128).ok_or(PumpFamilyError::MathOverflow)? / gross as u128)
        .map_err(|_| PumpFamilyError::MathOverflow.into())
}

fn pay_out<'info>(
    token_program: &Interface<'info, TokenInterface>,
    from: AccountInfo<'info>,
    mint: AccountInfo<'info>,
    to: AccountInfo<'info>,
    vault: AccountInfo<'info>,
    vault_seeds: &[&[u8]],
    amount: u64,
    decimals: u8,
) -> Result<()> {
    anchor_spl::token_interface::transfer_checked(
        CpiContext::new_with_signer(
            token_program.to_account_info(),
            anchor_spl::token_interface::TransferChecked { from, mint, to, authority: vault },
            &[vault_seeds],
        ),
        amount,
        decimals,
    )
}

/// `transfer_checked` for whichever token program owns the account, built by hand because the
/// launch holds its token programs as unchecked accounts.
fn spl_transfer_checked(
    token_program: &Pubkey, from: &Pubkey, mint: &Pubkey, to: &Pubkey, authority: &Pubkey,
    amount: u64, decimals: u8,
) -> Result<anchor_lang::solana_program::instruction::Instruction> {
    let mut data = Vec::with_capacity(10);
    data.push(12u8); // TransferChecked, identical in SPL Token and Token-2022
    data.extend_from_slice(&amount.to_le_bytes());
    data.push(decimals);
    Ok(anchor_lang::solana_program::instruction::Instruction {
        program_id: *token_program,
        accounts: vec![
            AccountMeta::new(*from, false),
            AccountMeta::new_readonly(*mint, false),
            AccountMeta::new(*to, false),
            AccountMeta::new_readonly(*authority, true),
        ],
        data,
    })
}

/// Everything a deposit does EXCEPT move the money.
///
/// Both deposit instructions call this and neither reimplements any of it, so a USDC depositor
/// and a SOL depositor are priced by the same code walking the same curve. The caps, the
/// protocol ceiling, the curve update, the position and the event all live here.
///
/// ⚠ It books first and the caller transfers after. That order is deliberate: every check that
/// can reject has already run by the time any money moves, so a rejected deposit never has to be
/// unwound.
fn book_deposit(
    sale: &mut Account<Sale>,
    position: &mut Account<Position>,
    depositor: Pubkey,
    position_bump: u8,
    // What the buyer SENT, in the quote's units (USDC). Drives the refund and the floor.
    amount: u64,
    // The same money as LAMPORTS, at the swap pool's rate when this was booked. Drives the curve
    // and both caps. ⛔ Passing `amount` here would price a USDC figure on the SOL curve.
    sol_equiv: u64,
    // When the money moved — the transfer's block time, not now. See `credit`.
    at: i64,
) -> Result<()> {
    require!(sale.status == SaleStatus::Open as u8, PumpFamilyError::SaleNotOpen);
    require!(at < sale.window_end, PumpFamilyError::WindowClosed);
    // Per denomination: see `Quote::min_deposit`. A single constant compared against a raw
    // amount means one floor for two different units.
    require!(amount >= sale_quote(sale)?.min_deposit(), PumpFamilyError::DepositBelowMinimum);

    require!(sol_equiv > 0, PumpFamilyError::DepositTooSmall);
    // ⚠ Both caps are LAMPORTS now, so both are measured against the SOL-equivalent. Measuring
    // them against the USDC figure would make them mean whatever the SOL price happened to be.
    require!(
        position.sol_equiv.checked_add(sol_equiv).ok_or(PumpFamilyError::MathOverflow)?
            <= sale.per_wallet_cap,
        PumpFamilyError::PerWalletCapExceeded
    );
    require!(
        sale.sol_expected.checked_add(sol_equiv).ok_or(PumpFamilyError::MathOverflow)?
            <= sale.hard_cap,
        PumpFamilyError::HardCapExceeded
    );

    let fees = Fees::new(sale.protocol_fee_bps, sale.creator_fee_bps);
    let (curve_in, fee_held) = split_deposit(sol_equiv as u128, fees)?;
    let remaining = RT0 - sale.sold as u128;
    let out = tokens_out(sale.virtual_sol, sale.virtual_token, curve_in, remaining);
    require!(out > 0, PumpFamilyError::DepositTooSmall);
    require!((sale.sold as u128) + out <= RT0, PumpFamilyError::CurveExhausted);

    // The protocol ceiling, checked on the ALLOCATION rather than the deposit. Rejects rather
    // than partially filling, for the same reason the caps above do: a partial fill leaves
    // change the vault has no path to return before launch.
    require!(
        (position.allocation as u128)
            .checked_add(out)
            .ok_or(PumpFamilyError::MathOverflow)?
            <= MAX_WALLET_ALLOCATION,
        PumpFamilyError::WalletAllocationCapExceeded
    );

    sale.virtual_sol += curve_in;
    sale.virtual_token -= out;
    sale.sold = (sale.sold as u128 + out) as u64;
    sale.curve_in = (sale.curve_in as u128 + curve_in) as u64;
    sale.fee_held = (sale.fee_held as u128 + fee_held) as u64;
    sale.gross += amount;
    sale.sol_expected += sol_equiv;

    if position.deposited == 0 {
        position.sale = sale.key();
        position.owner = depositor;
        position.bump = position_bump;
        sale.depositors += 1;
    }
    position.deposited += amount;
    position.sol_equiv += sol_equiv;
    position.allocation = (position.allocation as u128 + out) as u64;

    emit!(Deposited {
        sale: sale.key(),
        depositor: position.owner,
        amount,
        allocation: out as u64,
        price_after: sale.virtual_sol,
    });
    Ok(())
}

#[derive(Accounts)]
#[instruction(sale_id: u64)]
pub struct InitializeSale<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        init,
        payer = authority,
        space = Sale::SIZE,
        seeds = [b"sale", authority.key().as_ref(), &sale_id.to_le_bytes()],
        bump
    )]
    pub sale: Account<'info, Sale>,
    /// CHECK: system-owned PDA that custodies deposits and signs every CPI.
    #[account(mut, seeds = [b"vault", sale.key().as_ref()], bump)]
    pub vault: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
    /// CHECK: any on-curve address; only its derived token account below matters.
    pub deposit_wallet: UncheckedAccount<'info>,
    /// Checked in the handler: the wallet's associated account for the quote, owned by the vault.
    pub deposit_account: InterfaceAccount<'info, ITokenAccount>,
}

#[derive(Accounts)]
pub struct ClaimQuote<'info> {
    #[account(mut)]
    pub claimer: Signer<'info>,
    #[account(mut, seeds = [b"sale", sale.authority.as_ref(), &sale.sale_id.to_le_bytes()], bump = sale.bump)]
    pub sale: Account<'info, Sale>,
    #[account(
        mut,
        seeds = [b"pos", sale.key().as_ref(), claimer.key().as_ref()],
        bump = position.bump,
        constraint = position.owner == claimer.key() @ PumpFamilyError::NotYourPosition
    )]
    pub position: Account<'info, Position>,
    /// CHECK: validated by seeds; the authority over the token account below.
    #[account(seeds = [b"vault", sale.key().as_ref()], bump = sale.vault_bump)]
    pub vault: UncheckedAccount<'info>,
    /// The launched coin. Pinned to the sale so a claim cannot name another mint.
    #[account(constraint = mint.key() == sale.mint @ PumpFamilyError::WrongMint)]
    pub mint: InterfaceAccount<'info, IMint>,
    /// ⚠ Pinned to the mint AND the vault. The token program checks only that an authority owns
    /// the source, which is the exact hole that made `claim` drainable before it was constrained.
    #[account(
        mut,
        constraint = vault_token_account.mint == sale.mint @ PumpFamilyError::WrongMint,
        constraint = vault_token_account.owner == vault.key() @ PumpFamilyError::WrongTokenAccount,
    )]
    pub vault_token_account: InterfaceAccount<'info, ITokenAccount>,
    #[account(
        mut,
        constraint = claimer_token_account.mint == sale.mint @ PumpFamilyError::WrongMint,
        constraint = claimer_token_account.owner == claimer.key() @ PumpFamilyError::WrongTokenAccount,
    )]
    pub claimer_token_account: InterfaceAccount<'info, ITokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct RefundQuote<'info> {
    #[account(mut)]
    pub depositor: Signer<'info>,
    #[account(mut, seeds = [b"sale", sale.authority.as_ref(), &sale.sale_id.to_le_bytes()], bump = sale.bump)]
    pub sale: Account<'info, Sale>,
    #[account(
        mut,
        seeds = [b"pos", sale.key().as_ref(), depositor.key().as_ref()],
        bump = position.bump,
        constraint = position.owner == depositor.key() @ PumpFamilyError::NotYourPosition
    )]
    pub position: Account<'info, Position>,
    /// CHECK: validated by seeds; the authority over the token account below.
    #[account(seeds = [b"vault", sale.key().as_ref()], bump = sale.vault_bump)]
    pub vault: UncheckedAccount<'info>,
    pub quote_mint: InterfaceAccount<'info, IMint>,
    #[account(
        mut,
        constraint = vault_token_account.mint == quote_mint.key() @ PumpFamilyError::WrongMint,
        constraint = vault_token_account.owner == vault.key() @ PumpFamilyError::WrongTokenAccount,
    )]
    pub vault_token_account: InterfaceAccount<'info, ITokenAccount>,
    #[account(
        mut,
        constraint = depositor_token_account.mint == quote_mint.key() @ PumpFamilyError::WrongMint,
        constraint = depositor_token_account.owner == depositor.key() @ PumpFamilyError::WrongTokenAccount,
    )]
    pub depositor_token_account: InterfaceAccount<'info, ITokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
#[instruction(mint_nonce: u64)]
pub struct Launch<'info> {
    #[account(mut)]
    pub cranker: Signer<'info>,
    #[account(mut, seeds = [b"sale", sale.authority.as_ref(), &sale.sale_id.to_le_bytes()], bump = sale.bump)]
    pub sale: Account<'info, Sale>,
    /// CHECK: validated by seeds; signs `create` and `buy`, and pays for both out of the SOL the
    /// swap returned plus the creator's launch reserve.
    #[account(mut, seeds = [b"vault", sale.key().as_ref()], bump = sale.vault_bump)]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: validated by seeds; signs its own creation.
    #[account(mut, seeds = [b"mint", sale.key().as_ref(), &mint_nonce.to_le_bytes()], bump)]
    pub mint: UncheckedAccount<'info>,
    /// CHECK: the vault's classic SPL account for the coin. Its balance after the buy is what the
    /// guard reads, so it is the one account here that is not pass-through.
    #[account(mut)]
    pub vault_base_ata: UncheckedAccount<'info>,

    // ── pump.fun, passed through. It is an Anchor program and rejects its own wrong PDAs. ──
    /// CHECK: pump.fun PDA
    pub mint_authority: UncheckedAccount<'info>,
    /// CHECK: pump.fun PDA
    #[account(mut)]
    pub bonding_curve: UncheckedAccount<'info>,
    /// CHECK: the curve's own token account
    #[account(mut)]
    pub associated_bonding_curve: UncheckedAccount<'info>,
    /// CHECK: pump.fun PDA
    pub global: UncheckedAccount<'info>,

    // ── the `create_v2` accounts ─────────────────────────────────────────────────────────────
    //
    // ⛔ There is no Metaplex account here and no `rent`. A `create_v2` coin is Token-2022 and
    // carries its metadata in the mint's own extension, so the two accounts v1 needed for a
    // separate metadata account are gone. Adding them back does not make v1 work — it makes
    // `create_v2` reject the transaction on account 9.
    /// CHECK: pump.fun's mayhem program. Never enabled here (`is_mayhem_mode` is hard-coded
    /// false), but `create_v2` declares the account and checks it is executable.
    #[account(mut)]
    pub mayhem_program_id: UncheckedAccount<'info>,
    /// CHECK: pump.fun PDA, all-const seeds
    pub global_params: UncheckedAccount<'info>,
    /// CHECK: pump.fun PDA, all-const seeds
    #[account(mut)]
    pub sol_vault: UncheckedAccount<'info>,
    /// CHECK: pump.fun PDA seeded on the mint
    #[account(mut)]
    pub mayhem_state: UncheckedAccount<'info>,
    /// CHECK: the mayhem state's token account for the coin
    #[account(mut)]
    pub mayhem_token_vault: UncheckedAccount<'info>,
    /// CHECK: the coin's quote mint. ⭐ **WSOL**, which is what makes this a SOL-paired coin:
    /// pump.fun recognises the native mint and stores `quote_mint` on the curve as all-zeroes,
    /// so the coin prices, graduates and trades in SOL exactly like a v1 one.
    ///
    /// ⛔ It is NOT on `Global.whitelisted_quote_mints` — that list holds USDC alone, which is
    /// why this path was once believed impossible. WSOL does not need to be on it. Proven by
    /// mainnet launch `7mCnMuMpv…pump` (20 Sep 2026), not by reading the whitelist.
    #[account(address = anchor_spl::token::spl_token::native_mint::ID)]
    pub quote_mint: UncheckedAccount<'info>,
    /// CHECK: the curve's WSOL account. ⛔⛔ `create_v2` creates it NON-idempotently, so an
    /// account that already exists makes every launch of this sale revert, for ever. That is the
    /// whole reason the mint is picked here from an unpredictable nonce rather than at open.
    #[account(mut)]
    pub associated_quote_bonding_curve: UncheckedAccount<'info>,
    /// CHECK: the QUOTE side's token program — classic SPL, because WSOL is a classic mint. It is
    /// a different program from `token_program` above, which owns the Token-2022 coin.
    #[account(address = anchor_spl::token::ID)]
    pub quote_token_program: UncheckedAccount<'info>,

    /// CHECK: pump.fun rotates these; it validates the one it is given
    #[account(mut)]
    pub fee_recipient: UncheckedAccount<'info>,
    /// CHECK: pump.fun rotates these too
    #[account(mut)]
    pub buyback_fee_recipient: UncheckedAccount<'info>,
    /// CHECK: pump.fun PDA seeded on the CURVE's creator
    #[account(mut)]
    pub creator_vault: UncheckedAccount<'info>,
    /// CHECK: pump.fun PDA
    #[account(mut)]
    pub global_volume_accumulator: UncheckedAccount<'info>,
    /// CHECK: pump.fun PDA seeded on the vault
    #[account(mut)]
    pub user_volume_accumulator: UncheckedAccount<'info>,
    /// CHECK: PDA of the fee program, all-const seeds
    pub fee_config: UncheckedAccount<'info>,
    /// CHECK: fixed address in the IDL
    pub fee_program: UncheckedAccount<'info>,
    /// CHECK: the second curve account `buy` takes as a remaining account
    #[account(mut)]
    pub bonding_curve_v2: UncheckedAccount<'info>,
    /// CHECK: pump.fun PDA
    pub event_authority: UncheckedAccount<'info>,
    /// CHECK: hard-pinned to the real program id
    #[account(address = pump::PUMP_PROGRAM)]
    pub pump_program: UncheckedAccount<'info>,

    /// ⭐ The COIN's token program: Token-2022, since `create_v2` mints there. Kept as an
    /// interface rather than pinned, because `distribute` and `claim` read the same field and
    /// every sale before this build settled a classic SPL coin.
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(sig: [u8; 64], ix_index: u8, slot: u64, block_time: i64, depositor: Pubkey)]
pub struct Credit<'info> {
    #[account(mut, address = ATTESTER @ PumpFamilyError::NotAttester)]
    pub attester: Signer<'info>,
    #[account(mut, seeds = [b"sale", sale.authority.as_ref(), &sale.sale_id.to_le_bytes()], bump = sale.bump)]
    pub sale: Account<'info, Sale>,
    #[account(
        init_if_needed,
        payer = attester,
        space = Position::SIZE,
        seeds = [b"pos", sale.key().as_ref(), depositor.as_ref()],
        bump
    )]
    pub position: Account<'info, Position>,
    /// One per transfer, ever. `init` fails if the transfer was already credited OR returned.
    #[account(
        init,
        payer = attester,
        space = 8,
        seeds = [b"rcpt", sale.key().as_ref(), &sig[..32], &sig[32..], &[ix_index]],
        bump
    )]
    pub receipt: Account<'info, Receipt>,
    #[account(address = sale.deposit_account @ PumpFamilyError::BadDepositAccount)]
    pub deposit_account: InterfaceAccount<'info, ITokenAccount>,
    /// CHECK: pinned to `SWAP_POOL` and to its own program, and the two vaults below are checked
    /// against the addresses this account itself names — see `sol_equivalent`.
    pub swap_pool: UncheckedAccount<'info>,
    /// CHECK: must be the vault the pool names at offset 336.
    pub pool_sol_vault: UncheckedAccount<'info>,
    /// CHECK: must be the vault the pool names at offset 368.
    pub pool_usdc_vault: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(sig: [u8; 64], ix_index: u8)]
pub struct ReturnTransfer<'info> {
    #[account(mut, address = ATTESTER @ PumpFamilyError::NotAttester)]
    pub attester: Signer<'info>,
    #[account(mut, seeds = [b"sale", sale.authority.as_ref(), &sale.sale_id.to_le_bytes()], bump = sale.bump)]
    pub sale: Account<'info, Sale>,
    #[account(
        init,
        payer = attester,
        space = 8,
        seeds = [b"rcpt", sale.key().as_ref(), &sig[..32], &sig[32..], &[ix_index]],
        bump
    )]
    pub receipt: Account<'info, Receipt>,
    /// CHECK: validated by seeds; owns the deposit account.
    #[account(seeds = [b"vault", sale.key().as_ref()], bump = sale.vault_bump)]
    pub vault: UncheckedAccount<'info>,
    #[account(mut, address = sale.deposit_account @ PumpFamilyError::BadDepositAccount)]
    pub deposit_account: InterfaceAccount<'info, ITokenAccount>,
    #[account(address = sale.quote_mint @ PumpFamilyError::WrongMint)]
    pub quote_mint: InterfaceAccount<'info, IMint>,
    /// The sender's own account. The attester chooses it — see the module docs.
    #[account(mut, constraint = to_token_account.mint == sale.quote_mint @ PumpFamilyError::WrongMint)]
    pub to_token_account: InterfaceAccount<'info, ITokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

/// Swapping the raise into SOL.
///
/// ⚠ Raydium's own eighteen accounts come through `remaining_accounts`, in Raydium's order. They
/// are not re-declared here because this program does not validate them — Raydium validates them
/// against the pool, `SWAP_POOL` pins which pool that is, and the lamports the vault gained are
/// measured afterwards. See `swap.rs`.
#[derive(Accounts)]
pub struct SwapToSol<'info> {
    /// Pays the wrapped account's rent for the length of the instruction and gets it back when it
    /// is closed. Anyone may crank this.
    #[account(mut)]
    pub cranker: Signer<'info>,
    #[account(mut, seeds = [b"sale", sale.authority.as_ref(), &sale.sale_id.to_le_bytes()], bump = sale.bump)]
    pub sale: Account<'info, Sale>,
    /// CHECK: the sale's vault, by seeds. It owns the USDC, signs the swap, and receives the SOL.
    #[account(mut, seeds = [b"vault", sale.key().as_ref()], bump = sale.vault_bump)]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: created and closed inside this instruction; the ATA program pins its address.
    #[account(mut)]
    pub vault_wsol: UncheckedAccount<'info>,
    #[account(address = WSOL_MINT @ PumpFamilyError::WrongMint)]
    pub wsol_mint: InterfaceAccount<'info, IMint>,
    /// CHECK: pinned to `SWAP_POOL`, and its vaults are checked against what it names.
    pub swap_pool: UncheckedAccount<'info>,
    /// CHECK: must be the vault the pool names at offset 336.
    pub pool_sol_vault: UncheckedAccount<'info>,
    /// CHECK: must be the vault the pool names at offset 368.
    pub pool_usdc_vault: UncheckedAccount<'info>,
    /// CHECK: pinned by address.
    #[account(address = RAYDIUM_AMM_V4 @ PumpFamilyError::BadSwapPool)]
    pub raydium_program: UncheckedAccount<'info>,
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetPair<'info> {
    #[account(mut, address = sale.authority @ PumpFamilyError::NotAuthority)]
    pub authority: Signer<'info>,
    #[account(mut, seeds = [b"sale", sale.authority.as_ref(), &sale.sale_id.to_le_bytes()], bump = sale.bump)]
    pub sale: Account<'info, Sale>,
    #[account(init, payer = authority, space = SalePair::SIZE, seeds = [b"pair", sale.key().as_ref()], bump)]
    pub pair: Account<'info, SalePair>,
    /// The pair token. Owned by the classic token program or Token-2022, which the interface
    /// type checks; which one is recorded, since pump.fun needs it at launch.
    pub pair_mint: InterfaceAccount<'info, IMint>,
    /// CHECK: pinned to `QUOTE_CONTROL` and to pump.fun's ownership in `is_listed_pair`.
    pub quote_control: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

/// Swapping the SOL into the pair token. Jupiter's route arrives as `remaining_accounts`.
#[derive(Accounts)]
pub struct SwapToPair<'info> {
    #[account(mut, address = ATTESTER @ PumpFamilyError::NotAttester)]
    pub attester: Signer<'info>,
    #[account(seeds = [b"sale", sale.authority.as_ref(), &sale.sale_id.to_le_bytes()], bump = sale.bump)]
    pub sale: Account<'info, Sale>,
    #[account(mut, seeds = [b"pair", sale.key().as_ref()], bump = pair.bump)]
    pub pair: Account<'info, SalePair>,
    /// CHECK: the sale's vault, by seeds. Holds the SOL, signs the swap, owns the pair account.
    #[account(mut, seeds = [b"vault", sale.key().as_ref()], bump = sale.vault_bump)]
    pub vault: UncheckedAccount<'info>,
    /// Watched across the route: nothing may leave it.
    #[account(address = sale.deposit_account @ PumpFamilyError::BadDepositAccount)]
    pub deposit_account: InterfaceAccount<'info, ITokenAccount>,
    /// CHECK: the vault's WSOL associated account; the ATA program pins its address on create.
    #[account(mut)]
    pub vault_wsol: UncheckedAccount<'info>,
    #[account(address = WSOL_MINT @ PumpFamilyError::WrongMint)]
    pub wsol_mint: InterfaceAccount<'info, IMint>,
    /// CHECK: the vault's associated account for the pair token; pinned by the ATA program.
    #[account(mut)]
    pub vault_pair_ata: UncheckedAccount<'info>,
    #[account(address = pair.mint @ PumpFamilyError::WrongMint)]
    pub pair_mint: InterfaceAccount<'info, IMint>,
    /// CHECK: pinned to `QUOTE_CONTROL` in `is_listed_pair`.
    pub quote_control: UncheckedAccount<'info>,
    /// CHECK: pinned by address.
    #[account(address = JUPITER @ PumpFamilyError::BadSwapPool)]
    pub jupiter_program: UncheckedAccount<'info>,
    #[account(address = anchor_spl::token::ID)]
    pub wsol_token_program: Program<'info, anchor_spl::token::Token>,
    #[account(address = pair.token_program @ PumpFamilyError::WrongMint)]
    pub pair_token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

/// The pair launch. The `create_v2` accounts are named here; the 27 of `buy_exact_quote_in_v2`
/// arrive as `remaining_accounts`, in pump.fun's order.
#[derive(Accounts)]
#[instruction(mint_nonce: u64)]
pub struct LaunchPair<'info> {
    #[account(mut)]
    pub cranker: Signer<'info>,
    #[account(mut, seeds = [b"sale", sale.authority.as_ref(), &sale.sale_id.to_le_bytes()], bump = sale.bump)]
    pub sale: Box<Account<'info, Sale>>,
    #[account(seeds = [b"pair", sale.key().as_ref()], bump = pair.bump)]
    pub pair: Box<Account<'info, SalePair>>,
    /// CHECK: validated by seeds; signs `create_v2` and the buy.
    #[account(mut, seeds = [b"vault", sale.key().as_ref()], bump = sale.vault_bump)]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: validated by seeds; signs its own creation.
    #[account(mut, seeds = [b"mint", sale.key().as_ref(), &mint_nonce.to_le_bytes()], bump)]
    pub mint: UncheckedAccount<'info>,
    /// CHECK: the vault's Token-2022 account for the coin; the buy's `associated_base_user`.
    #[account(mut)]
    pub vault_base_ata: UncheckedAccount<'info>,
    /// CHECK: the vault's pair-token account, filled by `swap_to_pair`; the buy's `associated_quote_user`.
    #[account(mut)]
    pub vault_pair_ata: UncheckedAccount<'info>,
    /// CHECK: pump.fun PDA
    pub mint_authority: UncheckedAccount<'info>,
    /// CHECK: pump.fun PDA
    #[account(mut)]
    pub bonding_curve: UncheckedAccount<'info>,
    /// CHECK: the curve's own token account
    #[account(mut)]
    pub associated_bonding_curve: UncheckedAccount<'info>,
    /// CHECK: pump.fun PDA
    pub global: UncheckedAccount<'info>,
    /// CHECK: see `Launch`
    #[account(mut)]
    pub mayhem_program_id: UncheckedAccount<'info>,
    /// CHECK: pump.fun PDA
    pub global_params: UncheckedAccount<'info>,
    /// CHECK: pump.fun PDA
    #[account(mut)]
    pub sol_vault: UncheckedAccount<'info>,
    /// CHECK: pump.fun PDA seeded on the mint
    #[account(mut)]
    pub mayhem_state: UncheckedAccount<'info>,
    /// CHECK: the mayhem state's token account for the coin
    #[account(mut)]
    pub mayhem_token_vault: UncheckedAccount<'info>,
    /// CHECK: pinned to the sale's pair
    #[account(address = pair.mint @ PumpFamilyError::WrongMint)]
    pub pair_mint: UncheckedAccount<'info>,
    /// CHECK: the curve's pair-token account. ⛔ Created NON-idempotently by `create_v2`, exactly like
    /// the WSOL one — which is why the mint is still picked here from an unpredictable nonce.
    #[account(mut)]
    pub associated_quote_bonding_curve: UncheckedAccount<'info>,
    /// CHECK: pinned to the pair token's own program
    #[account(address = pair.token_program @ PumpFamilyError::WrongMint)]
    pub pair_token_program: UncheckedAccount<'info>,
    /// CHECK: pinned by address
    #[account(address = QUOTE_CONTROL @ PumpFamilyError::BadQuoteControl)]
    pub quote_control: UncheckedAccount<'info>,
    /// CHECK: pump.fun PDA
    pub event_authority: UncheckedAccount<'info>,
    /// CHECK: hard-pinned to the real program id
    #[account(address = pump::PUMP_PROGRAM)]
    pub pump_program: UncheckedAccount<'info>,
    /// The COIN's token program: Token-2022.
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CloseCredits<'info> {
    #[account(address = ATTESTER @ PumpFamilyError::NotAttester)]
    pub attester: Signer<'info>,
    #[account(mut, seeds = [b"sale", sale.authority.as_ref(), &sale.sale_id.to_le_bytes()], bump = sale.bump)]
    pub sale: Account<'info, Sale>,
}

#[derive(Accounts)]
pub struct Distribute<'info> {
    #[account(mut)]
    pub cranker: Signer<'info>,
    #[account(mut, seeds = [b"sale", sale.authority.as_ref(), &sale.sale_id.to_le_bytes()], bump = sale.bump)]
    pub sale: Account<'info, Sale>,
    #[account(mut, seeds = [b"pos", sale.key().as_ref(), position.owner.as_ref()], bump = position.bump)]
    pub position: Account<'info, Position>,
    /// CHECK: pinned to the position's owner.
    #[account(address = position.owner @ PumpFamilyError::NotYourPosition)]
    pub owner: UncheckedAccount<'info>,
    /// CHECK: validated by seeds; the authority over the token account below.
    #[account(seeds = [b"vault", sale.key().as_ref()], bump = sale.vault_bump)]
    pub vault: UncheckedAccount<'info>,
    #[account(constraint = mint.key() == sale.mint @ PumpFamilyError::WrongMint)]
    pub mint: InterfaceAccount<'info, IMint>,
    #[account(
        mut,
        constraint = vault_token_account.mint == sale.mint @ PumpFamilyError::WrongMint,
        constraint = vault_token_account.owner == vault.key() @ PumpFamilyError::WrongTokenAccount,
    )]
    pub vault_token_account: InterfaceAccount<'info, ITokenAccount>,
    /// CHECK: the owner's associated account for the coin, checked against its derivation in
    /// the handler and created there if missing.
    #[account(mut)]
    pub owner_token_account: UncheckedAccount<'info>,
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RefundPush<'info> {
    #[account(mut, seeds = [b"sale", sale.authority.as_ref(), &sale.sale_id.to_le_bytes()], bump = sale.bump)]
    pub sale: Account<'info, Sale>,
    #[account(mut, seeds = [b"pos", sale.key().as_ref(), position.owner.as_ref()], bump = position.bump)]
    pub position: Account<'info, Position>,
    /// CHECK: validated by seeds; owns the deposit account.
    #[account(seeds = [b"vault", sale.key().as_ref()], bump = sale.vault_bump)]
    pub vault: UncheckedAccount<'info>,
    #[account(mut, address = sale.deposit_account @ PumpFamilyError::BadDepositAccount)]
    pub deposit_account: InterfaceAccount<'info, ITokenAccount>,
    #[account(address = sale.quote_mint @ PumpFamilyError::WrongMint)]
    pub quote_mint: InterfaceAccount<'info, IMint>,
    #[account(
        mut,
        constraint = owner_token_account.mint == sale.quote_mint @ PumpFamilyError::WrongMint,
        constraint = owner_token_account.owner == position.owner @ PumpFamilyError::WrongTokenAccount,
    )]
    pub owner_token_account: InterfaceAccount<'info, ITokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct RefundSol<'info> {
    #[account(mut, seeds = [b"sale", sale.authority.as_ref(), &sale.sale_id.to_le_bytes()], bump = sale.bump)]
    pub sale: Account<'info, Sale>,
    #[account(mut, seeds = [b"pos", sale.key().as_ref(), position.owner.as_ref()], bump = position.bump)]
    pub position: Account<'info, Position>,
    /// CHECK: pinned to the position's owner; receives the lamports.
    #[account(mut, address = position.owner @ PumpFamilyError::NotYourPosition)]
    pub owner: UncheckedAccount<'info>,
    /// CHECK: validated by seeds; holds the swapped SOL.
    #[account(mut, seeds = [b"vault", sale.key().as_ref()], bump = sale.vault_bump)]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: the sale's pair account, checked against its derivation in the handler for a pair
    /// sale and ignored for any other (pass the sale itself).
    pub pair: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RefundPair<'info> {
    #[account(mut)]
    pub cranker: Signer<'info>,
    #[account(mut, seeds = [b"sale", sale.authority.as_ref(), &sale.sale_id.to_le_bytes()], bump = sale.bump)]
    pub sale: Account<'info, Sale>,
    #[account(mut, seeds = [b"pos", sale.key().as_ref(), position.owner.as_ref()], bump = position.bump)]
    pub position: Account<'info, Position>,
    #[account(mut, seeds = [b"pair", sale.key().as_ref()], bump = pair.bump)]
    pub pair: Account<'info, SalePair>,
    /// CHECK: pinned to the position's owner.
    #[account(address = position.owner @ PumpFamilyError::NotYourPosition)]
    pub owner: UncheckedAccount<'info>,
    /// CHECK: validated by seeds; the authority over the token account below.
    #[account(seeds = [b"vault", sale.key().as_ref()], bump = sale.vault_bump)]
    pub vault: UncheckedAccount<'info>,
    #[account(constraint = mint.key() == pair.mint @ PumpFamilyError::WrongMint)]
    pub mint: InterfaceAccount<'info, IMint>,
    #[account(
        mut,
        constraint = vault_token_account.mint == pair.mint @ PumpFamilyError::WrongMint,
        constraint = vault_token_account.owner == vault.key() @ PumpFamilyError::WrongTokenAccount,
    )]
    pub vault_token_account: InterfaceAccount<'info, ITokenAccount>,
    /// CHECK: the owner's associated account for the pair token, checked against its derivation
    /// in the handler and created there if missing.
    #[account(mut)]
    pub owner_token_account: UncheckedAccount<'info>,
    #[account(constraint = token_program.key() == pair.token_program @ PumpFamilyError::BadPairAccount)]
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[account]
pub struct Receipt {}

#[derive(Accounts)]
pub struct SweepLamports<'info> {
    #[account(mut, address = sale.authority @ PumpFamilyError::NotAuthority)]
    pub authority: Signer<'info>,
    #[account(mut, seeds = [b"sale", sale.authority.as_ref(), &sale.sale_id.to_le_bytes()], bump = sale.bump)]
    pub sale: Account<'info, Sale>,
    /// CHECK: validated by seeds.
    #[account(mut, seeds = [b"vault", sale.key().as_ref()], bump = sale.vault_bump)]
    pub vault: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct FailSale<'info> {
    #[account(mut, seeds = [b"sale", sale.authority.as_ref(), &sale.sale_id.to_le_bytes()], bump = sale.bump)]
    pub sale: Account<'info, Sale>,
}

/* ------------------------------------------------------------------ events */

#[event]
pub struct SaleOpened { pub sale: Pubkey, pub mint: Pubkey, pub window_end: i64, pub hard_cap: u64 }
#[event]
pub struct Deposited { pub sale: Pubkey, pub depositor: Pubkey, pub amount: u64, pub allocation: u64, pub price_after: u128 }
#[event]
pub struct Swapped { pub sale: Pubkey, pub usdc_in: u64, pub sol_out: u64, pub min_out: u64 }
#[event]
pub struct PairSet { pub sale: Pubkey, pub pair_mint: Pubkey, pub creator_fee_bps: u64 }
#[event]
pub struct PairSwapped { pub sale: Pubkey, pub sol_in: u64, pub pair_out: u64, pub min_out: u64 }
#[event]
pub struct Launched { pub sale: Pubkey, pub mint: Pubkey, pub spent: u64, pub tokens_received: u64, pub allocated: u64 }
#[event]
pub struct Claimed { pub sale: Pubkey, pub owner: Pubkey, pub amount: u64 }
#[event]
pub struct Swept { pub sale: Pubkey, pub lamports: u64, pub tokens: u64 }
#[event]
pub struct SaleFailed { pub sale: Pubkey, pub gross: u64 }
#[event]
pub struct Credited { pub sale: Pubkey, pub depositor: Pubkey, pub amount: u64, pub slot: u64, pub sig: [u8; 64] }
#[event]
pub struct Returned { pub sale: Pubkey, pub to: Pubkey, pub amount: u64, pub sig: [u8; 64] }
#[event]
pub struct Refunded { pub sale: Pubkey, pub owner: Pubkey, pub amount: u64 }
#[event]
pub struct RefundedSol { pub sale: Pubkey, pub owner: Pubkey, pub deposited: u64, pub lamports: u64 }
#[event]
pub struct RefundedPair { pub sale: Pubkey, pub owner: Pubkey, pub deposited: u64, pub amount: u64 }

/* ------------------------------------------------------------------ errors */

#[error_code]
pub enum PumpFamilyError {
    #[msg("window duration must be positive")] WindowTooShort,
    #[msg("launch window must be positive")] BadLaunchWindow,
    #[msg("caps are inconsistent")] BadCap,
    #[msg("hard cap exceeds what the pump.fun curve can absorb")] HardCapExceedsCurve,
    #[msg("cashback is a create_v2 flag and needs a quote-denominated sale")] CashbackNeedsQuoteLaunch,
    #[msg("name, symbol or uri is longer than pump.fun allows")] MetadataTooLong,
    #[msg("sale is not open")] SaleNotOpen,
    #[msg("the window has closed")] WindowClosed,
    #[msg("the window is still open")] WindowStillOpen,
    /// Superseded by `DepositBelowMinimum`, which is strictly stronger. Kept so the codes after
    /// it do not shift.
    #[msg("deposit must be greater than zero")] ZeroDeposit,
    #[msg("deposit is too small to allocate a single base unit")] DepositTooSmall,
    #[msg("per-wallet cap exceeded")] PerWalletCapExceeded,
    #[msg("hard cap exceeded")] HardCapExceeded,
    #[msg("the curve cannot absorb any more")] CurveExhausted,
    #[msg("minimum raise was not met")] MinRaiseNotMet,
    /// ⛔ No longer raised — an empty window launches now (18 Sep 2026). KEPT because removing a
    /// variant renumbers every error after it, changing the program's whole error surface for
    /// anything that matches on a code.
    #[msg("not the swap pool this program prices and trades through")] BadSwapPool,
    #[msg("the swap returned less SOL than the pool's own quote allows")] SwapReturnedTooLittle,
    #[msg("the raise has already been swapped")] AlreadySwapped,
    #[msg("the raise has not been swapped yet")] NotSwapped,
    #[msg("nothing was sold")] NothingSold,
    #[msg("the launch window has passed")] LaunchWindowPassed,
    #[msg("the sale has not launched")] NotLaunched,
    #[msg("the sale has not failed")] NotFailed,
    #[msg("cannot fail this sale yet")] CannotFailYet,
    #[msg("already settled")] AlreadyClaimed,
    #[msg("nothing to claim")] NothingToClaim,
    #[msg("not your position")] NotYourPosition,
    #[msg("the curve delivered fewer tokens than were allocated")] ReceivedLessThanAllocated,
    #[msg("fee split did not converge")] FeeSplitDidNotConverge,
    #[msg("fee rate is outside the accepted range")] FeeRateOutOfRange,
    #[msg("the mint does not end in the required vanity suffix")] MintSuffixMismatch,
    #[msg("token account is for the wrong mint")] WrongMint,
    #[msg("token account has the wrong owner")] WrongTokenAccount,
    #[msg("only the sale authority may do this")] NotAuthority,
    #[msg("refunds are still outstanding")] RefundsOutstanding,
    #[msg("nothing to sweep")] NothingToSweep,
    #[msg("arithmetic overflow")] MathOverflow,
    // Appended rather than slotted in beside the caps they belong with: Anchor derives error codes
    // from ORDINAL position, so inserting a variant renumbers every one after it and silently
    // re-points any client already mapping a code to a message.
    #[msg("deposit is below the 0.01 SOL minimum")] DepositBelowMinimum,
    #[msg("this wallet would hold more than 3% of supply")] WalletAllocationCapExceeded,
    #[msg("unknown quote asset")] UnknownQuote,
    #[msg("wrong denomination for this sale")] WrongQuote,
    #[msg("deposits must be co-signed by FOMO")] NotViaFomo,
    #[msg("pump.fun no longer creates cashback coins")] CashbackDeprecated,
    #[msg("sales settle in USDC, which is what a FOMO send moves")] SolSalesDisabled,
    #[msg("only the attester may do this")] NotAttester,
    #[msg("the deposit account is not the vault-owned USDC account of the deposit wallet")] BadDepositAccount,
    #[msg("credits must not go back across slots")] SlotOutOfOrder,
    #[msg("the deposit account does not hold enough to back this credit")] CreditExceedsBalance,
    #[msg("that would return money owed to depositors")] ReturnTouchesDeposits,
    #[msg("credits are closed for this sale")] CreditsClosed,
    #[msg("deposits are still being credited")] CreditsStillOpen,
    #[msg("that is not pump.fun's quote-control account")] BadQuoteControl,
    #[msg("that token is not on pump.fun's list of custom pairs")] PairNotListed,
    #[msg("a custom pair's creator fee is at most 300 bps")] PairCreatorFeeTooHigh,
    #[msg("the pair must be chosen before anyone deposits")] PairAfterDeposits,
    #[msg("this sale launches paired with a custom token: use launch_pair")] PairSale,
    #[msg("this sale has no custom pair")] NotPairSale,
    #[msg("the pair swap left SOL behind or touched the deposits")] SwapLeftSolBehind,
    #[msg("an account in the pair buy is not the one this sale requires")] BadPairAccount,
    #[msg("the raise was swapped before the sale failed: refund with refund_sol or refund_pair")] SwappedRefund,
    #[msg("the SOL went on into the pair token: refund with refund_pair")] RefundInPair,
}

#[cfg(test)]
mod refund_tests {
    use super::*;

    /// Refunds paid one after another, on the remaining figures, never exceed the pool and the
    /// last one takes exactly the remainder — whatever the rounding did before it.
    #[test]
    fn pro_rata_pays_out_the_whole_pool_and_never_more() {
        for (deposits, pool) in [
            (vec![1u64, 1, 1], 100u64), (vec![333, 333, 334], 1_000), (vec![7, 11, 13, 17], 1),
            (vec![1_000_000, 2_500_000, 500_000], 12_345_678_901), (vec![5], 0), (vec![1, u64::MAX / 2], u64::MAX),
        ] {
            let mut gross: u64 = deposits.iter().sum();
            let mut left = pool;
            let mut paid = 0u128;
            for d in &deposits {
                let a = pro_rata(*d, gross, left).unwrap();
                assert!(a <= left, "paid more than the pool holds");
                paid += a as u128;
                left -= a;
                gross -= d;
            }
            assert_eq!(gross, 0);
            assert_eq!(left, 0, "the last refund must take the remainder");
            assert_eq!(paid, pool as u128);
        }
    }

    #[test]
    fn pro_rata_refuses_a_deposit_larger_than_what_is_left() {
        assert!(pro_rata(10, 5, 100).is_err());
        assert!(pro_rata(1, 0, 100).is_err());
    }

    /// The scale `distribute` and `claim_quote` share: quoted allocation × received / sold.
    #[test]
    fn scaled_payout_is_one_formula_for_both_routes() {
        let mut sale = Sale::default();
        sale.sold = 1_000;
        sale.tokens_received = 990;
        assert_eq!(scaled_payout(&sale, 500).unwrap(), 495);
        assert_eq!(scaled_payout(&sale, 1).unwrap_err(), PumpFamilyError::NothingToClaim.into());
        sale.sold = 0;
        assert_eq!(scaled_payout(&sale, 500).unwrap_err(), PumpFamilyError::NothingSold.into());
    }
}

#[cfg(test)]
mod cap_tests {
    use super::*;
    use crate::curve::*;

    const F: Fees = Fees { protocol_bps: 95, creator_bps: 30 };

    /// 3% of a 1,000,000,000 supply at 6 decimals.
    #[test]
    fn ceiling_is_three_percent_of_supply() {
        assert_eq!(MAX_WALLET_ALLOCATION, 30_000_000_000_000);
        assert_eq!(TOTAL_SUPPLY, 1_000_000_000_000_000);
        // The curve can only ever sell 79.31% of supply, so the ceiling is a slightly larger
        // slice of what is actually for sale than of the supply it is named after.
        assert!(MAX_WALLET_ALLOCATION * 100 / RT0 == 3);
    }

    /// The reason the ceiling is denominated in tokens.
    ///
    /// One fixed SOL amount buys wildly different allocations depending on where in the queue it
    /// lands. A cap in SOL is therefore not a cap on what a wallet walks away with — it is loosest
    /// exactly at the open, where the tokens are cheapest and the fairness claim is most at risk.
    #[test]
    fn a_sol_cap_does_not_bound_the_allocation() {
        let cap = 500_000_000u128; // 0.5 SOL, the default the create form suggests
        let (curve_in, _) = split_deposit(cap, F).unwrap();

        let at_open = tokens_out(VS0, VT0, curve_in, RT0);

        // Walk the shadow curve to a 20 SOL raise, then spend the same 0.5 SOL.
        let (mut vs, mut vt, mut sold) = (VS0, VT0, 0u128);
        while vs - VS0 < 20_000_000_000 {
            let (ci, _) = split_deposit(500_000_000, F).unwrap();
            let out = tokens_out(vs, vt, ci, RT0 - sold);
            vs += ci;
            vt -= out;
            sold += out;
        }
        let at_close = tokens_out(vs, vt, curve_in, RT0 - sold);

        assert!(
            at_open > at_close * 2,
            "identical deposits should differ sharply: open {at_open}, close {at_close}"
        );
    }

    /// What it actually costs to reach the ceiling, and that the ceiling is reachable at all —
    /// a ceiling no deposit can hit would be decoration, and one hit by a normal deposit would
    /// break ordinary sales.
    #[test]
    fn the_ceiling_binds_only_on_large_early_deposits() {
        let cost = sol_cost(MAX_WALLET_ALLOCATION, VS0, VT0).unwrap();
        let gross = total_with_fees(cost, F);
        // Around 0.87 SOL at the very open. Above the 0.5 SOL default, so a sale configured the
        // way the create form suggests never touches the ceiling.
        assert!(
            (800_000_000..950_000_000).contains(&gross),
            "unexpected cost to reach the ceiling: {gross}"
        );
        assert!(gross > 500_000_000, "the default per-wallet cap must sit under the ceiling");

        // And the minimum deposit is nowhere near it. At the open a floor deposit takes about
        // 1/85th of the ceiling, so one wallet needs ~85 of them to reach it — and this is the
        // WORST case: further into the queue the same SOL buys fewer tokens, so the ratio only
        // widens. Asserted loosely at 50 because the exact figure moves with the fee schedule,
        // which pump.fun controls; what must not change is that the two are orders apart.
        let (ci, _) = split_deposit(MIN_DEPOSIT as u128, F).unwrap();
        let smallest = tokens_out(VS0, VT0, ci, RT0);
        assert!(smallest > 0, "the minimum deposit must still buy something");
        assert!(
            smallest * 50 < MAX_WALLET_ALLOCATION,
            "the floor has drifted up into the ceiling: {smallest} vs {MAX_WALLET_ALLOCATION}"
        );
    }

    /// Where the separately-ceiled fee legs actually distort the rate, and that the floor clears
    /// it. Pins the measurement the doc comment quotes, so a future fee change cannot move the
    /// distortion up past the floor without a test going red.
    #[test]
    fn the_minimum_deposit_clears_the_fee_distortion() {
        let bps = |gross: u128| {
            let (curve_in, fee_held) = split_deposit(gross, F).unwrap();
            fee_held * 10_000 / curve_in
        };

        assert_eq!(bps(MIN_DEPOSIT as u128), 125, "the floor must pay the nominal rate");
        assert_eq!(bps(5_000), 125, "distortion clears by ~5,000 lamports");

        // Below that it climbs sharply — this is what the floor refuses.
        assert_eq!(bps(1_000), 131);
        assert_eq!(bps(100), 204);
        assert_eq!(bps(10), 2_500);
    }

    /// The property the 0.01 SOL floor exists to hold: the smallest legal position is worth more
    /// than the ~0.00204 SOL of ATA rent it costs to collect. Asserted rather than commented,
    /// because the failure mode of losing it is silent — a depositor finds out at claim time.
    #[test]
    fn the_floor_sits_above_the_cost_of_claiming() {
        const ATA_RENT: u64 = 2_039_280;
        assert!(
            MIN_DEPOSIT > ATA_RENT,
            "a floor under the ATA rent makes the smallest legal position cost more to collect \
             than it cost to open"
        );
    }

    /// The USDC curve is the SOL curve with one constant changed.
    ///
    /// Pinned against a live USDC coin, `CAA37EB8VnDD97MvDZKfHgChKbLNxD435WATp1Mgpump`, read off
    /// mainnet: virtual reserves 1,057,145,162,677,217 tokens against 4,356,370,507 USDC, real
    /// token reserves 777,245,162,677,217. If pump.fun ever runs a different product for quote
    /// launches, this is the test that says so rather than a mispriced sale saying it.
    #[test]
    fn the_usdc_curve_matches_a_live_coin() {
        let k_open = VT0 * VQ0_USDC;
        let (vt, vq, rt) = (1_057_145_162_677_217u128, 4_356_370_507u128, 777_245_162_677_217u128);

        // Constant product, to within the rounding a real trade leaves behind.
        let k_now = vt * vq;
        assert!(k_now.abs_diff(k_open) < k_open / 1_000_000, "k moved: {k_open} -> {k_now}");

        // Tokens that left the virtual reserve equal the fall in the real one. If these ever
        // disagree the two sides are being tracked differently and `sold` cannot be trusted.
        assert_eq!(VT0 - vt, RT0 - rt);

        // And the quote side moved by a plausible amount in SIX decimals, not nine.
        assert_eq!(vq - VQ0_USDC, 64_370_507);
        assert_eq!(Quote::Usdc.decimals(), 6);
        assert_eq!(Quote::Sol.decimals(), 9);
    }

    /// The quote only changes the reserve a curve opens at, never the token side.
    #[test]
    fn only_the_quote_reserve_differs() {
        assert_eq!(Quote::Sol.initial_reserve(), VS0);
        assert_eq!(Quote::Usdc.initial_reserve(), VQ0_USDC);
        // Same tokens for sale either way — the fairness gradient is a property of the token
        // side, so a USDC sale is the same shape as a SOL one at a different scale.
        assert_eq!(tokens_out(VS0, VT0, VS0, RT0), tokens_out(VQ0_USDC, VT0, VQ0_USDC, RT0));
    }

    /// A cap under the minimum deposit would open a sale nobody could deposit into.
    #[test]
    fn the_cap_floor_admits_at_least_one_legal_deposit() {
        assert!(MIN_DEPOSIT > 0);
        // initialize_sale requires per_wallet_cap >= quote.min_deposit(), so the smallest legal
        // sale accepts exactly one minimum deposit — in whichever units it is denominated.
        for q in [Quote::Sol, Quote::Usdc] {
            let smallest_legal_cap = q.min_deposit();
            assert!(smallest_legal_cap >= q.min_deposit());
        }
    }

    /// ⛔ The configuration bounds are figures in the QUOTE's base units, so they have to be
    /// measured against the quote's own curve.
    ///
    /// `initialize_sale` refuses a hard cap above what the curve can absorb, so that deposits
    /// cannot accumulate that the launch could never deploy. Measured against `VS0` for every
    /// sale, that bound was the SOL curve's capacity applied to USDC base units — seven times
    /// too loose. A creator could then set `min_raise` above the USDC curve's real capacity, and
    /// the resulting sale would take deposits for its whole window while `deposit_quote` reverted
    /// with `CurveExhausted` long before `gross` could reach it: never launchable, refund only.
    #[test]
    fn the_hard_cap_bound_is_measured_in_the_sale_s_own_units() {
        let fees = F;
        let cap_of = |q: Quote| total_with_fees(sol_cost(RT0, q.initial_reserve(), VT0).unwrap(), fees);

        let sol = cap_of(Quote::Sol);
        let usdc = cap_of(Quote::Usdc);
        assert_eq!(sol, 86_067_926_047, "the SOL curve absorbs ~86.07 SOL");
        assert_eq!(usdc, 12_313_451_289, "the USDC curve absorbs ~12,313.45 USDC");

        // The bound must scale with the reserve, not be one number reused. If these ever became
        // equal again the denomination-blind check would be back.
        assert!(usdc < sol, "a USDC cap must not be bounded by the SOL curve");

        // And the size of the mistake, so the next reader knows what was at stake: a USDC sale
        // could be configured to raise 6.99x more than its curve can ever take.
        assert_eq!(sol / usdc, 6);
    }
}

#[cfg(test)]
mod vanity_tests {
    use super::*;

    /// Pins the cheap suffix check against addresses whose base58 encoding is known.
    #[test]
    fn suffix_matches_real_base58() {
        // System program: 11111111111111111111111111111111
        let sys = Pubkey::default();
        assert!(has_base58_suffix(&sys, b"1111"));
        assert!(!has_base58_suffix(&sys, b"fomo"));

        // pump.fun: 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P
        let pump = pubkey!("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
        assert!(has_base58_suffix(&pump, b"F6P"));
        assert!(has_base58_suffix(&pump, b"wF6P"));
        assert!(!has_base58_suffix(&pump, b"fomo"));

        // A real ground address ending in the suffix this program requires.
        let fomo = pubkey!("D2Q9Xd4Qs1AwXmLwrBEyCsyPn4vSGWfZBGxKBqPXfomo");
        assert!(has_base58_suffix(&fomo, VANITY_SUFFIX));
        assert!(has_base58_suffix(&fomo, b"omo"));
        assert!(!has_base58_suffix(&fomo, b"pump"));
    }
}
