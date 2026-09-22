/**
 * Pump Family client: PDAs, instruction encoders and account decoders.
 *
 * Shared deliberately. `integration.test.mjs` drives these against a validator running mainnet's
 * cloned pump.fun, and the web app imports the same functions — so the encoders the site sends are
 * the encoders that suite proves, rather than a second copy free to drift from them.
 */
import { PublicKey, SystemProgram, TransactionInstruction, SYSVAR_RENT_PUBKEY, Transaction, ComputeBudgetProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js'
import { getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, createSetAuthorityInstruction, AuthorityType, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from '@solana/spl-token'
// sha256 from @noble/hashes rather than node:crypto, so this one module runs unchanged in the
// browser and in the test suite. A second copy of these encoders is exactly what must not exist.
import { sha256 } from '@noble/hashes/sha2.js'

/**
 * 🔴 How many accounts may go in ONE `getMultipleAccounts`. **Not 100, the protocol limit.**
 *
 * publicnode — the endpoint the site, the indexer and the watcher all use — answers
 * `403 Request blocked` to a batch of 15 while answering 10 fine (measured 18 Sep 2026). Every
 * batched read in this project is capped here, in one place, because the failure is invisible
 * until there are enough of something: the indexer froze its listing above ten sales, the watcher
 * would have stopped DELIVERING TOKENS above ten buyers, and a visitor's portfolio spanning more
 * than ten sales would have rendered empty.
 */
/**
 * How many accounts go in one `getMultipleAccounts`. 10 by default because publicnode refuses
 * more (403 at 15, measured 18 Sep 2026); a keyed provider takes the protocol's 100, and
 * `RPC_BATCH=100` in the service env cuts the indexer's refresh to a tenth of the calls.
 */
export const RPC_BATCH = (() => { const v = Number(process.env.RPC_BATCH ?? 10); return Number.isInteger(v) && v >= 1 && v <= 100 ? v : 10 })()

/**
 * The swap venue, welded into the program — see `SWAP_POOL` in lib.rs.
 *
 * Every buy is quoted at this pool's spot and the whole raise is swapped through it at the close,
 * so a credit cannot be built without the three accounts that price it.
 */
export const RAYDIUM_AMM_V4 = new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8')
export const SWAP_POOL = new PublicKey('58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2')
export const WSOL_MINT = new PublicKey('So11111111111111111111111111111111111111112')
/**
 * The rest of the pool's account set — Raydium's AMM authority and open orders, and the OpenBook
 * market it trades on. Every one is fixed for this pool, so they all belong in the lookup table.
 *
 * ⚠ Pinned here rather than derived: they are fields of Raydium's own accounts, and deriving them
 * would mean reimplementing Raydium's layout for no benefit. Read from Raydium's pool-keys API on
 * 19 Sep 2026 and cross-checked against the pool account's own vault fields.
 */
export const SWAP_MARKET = {
  ammAuthority: new PublicKey('5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1'),
  ammOpenOrders: new PublicKey('HmiHHzq4Fym9e1D4qzLS6LDDM3tNsCTBPDWHTLZ763jY'),
  ammTargetOrders: new PublicKey('CZza3Ej4Mc58MnxWA385itCC9jCo3L1D7zc3LKy1bZMR'),
  serumProgram: new PublicKey('srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX'),
  serumMarket: new PublicKey('8BnEgHoWFysVcuFFX7QztDmzuH8r5ZFvyP3sYwn1XTh6'),
  serumBids: new PublicKey('5jWUncPNBMZJ3sTHKmMLszypVkoRK6bfEQMQUHweeQnh'),
  serumAsks: new PublicKey('EaXdHx7x3mdGA38j5RSmKYSXMzAFzzUXCLNBEDXDn1d5'),
  serumEventQueue: new PublicKey('8CvwxZ9Db6XbLD46NZwwmVDZZRDy7eydFcAGkXKh9axa'),
  serumCoinVault: new PublicKey('CKxTHwM9fPMRRvZmFnFoqKNd9pQR21c5Aq9bh5h9oghX'),
  serumPcVault: new PublicKey('6A5NHCj1yF6urc9wZNe6Bcjj4LVszQNj5DwAWG97yzMu'),
  serumVaultSigner: new PublicKey('CTz5UMLQm2SRWHzQnU62Pi4yJqbNGjgRBHqqp6oDHfF7'),
}
/** The two the pool itself names, for callers that have not read the pool account. */
export const SWAP_POOL_VAULTS = {
  solVault: new PublicKey('DQyrAcCrDXQ7NeoqGgDCZwBvWDcYmFCjSb9JtteuvPpz'),
  usdcVault: new PublicKey('HLmqeL62xR1QoZ1HKKbXRrdN1p3phKpxRMb2VVopvBBz'),
}

/** The pool names its own vaults at these offsets; read them rather than hardcoding addresses. */
export const POOL_SOL_VAULT_OFFSET = 336
export const POOL_USDC_VAULT_OFFSET = 368

/** The pool's two vault addresses, read off the pool account itself. */
export function poolVaults(poolData) {
  if (!poolData || poolData.length < POOL_USDC_VAULT_OFFSET + 32) throw new Error('not the swap pool')
  return {
    solVault: new PublicKey(poolData.subarray(POOL_SOL_VAULT_OFFSET, POOL_SOL_VAULT_OFFSET + 32)),
    usdcVault: new PublicKey(poolData.subarray(POOL_USDC_VAULT_OFFSET, POOL_USDC_VAULT_OFFSET + 32)),
  }
}

export const PROGRAM_ID = new PublicKey('8WkibpqR4jnkxpv8nHk9t3Rgw9L4UqECYYwiAGYnu8Hf')
export const PUMP = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P')
export const FEE_PROGRAM = new PublicKey('pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ')
export const MPL = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s')
export const FEE_RECIPIENT = new PublicKey('62qc2CNXwrYqQScmEdiZFFAnJR262PxWEuNQtxfafNgV')
export const BUYBACK = new PublicKey('5YxQFdt3Tr9zJLvkFccqXVUwhdTWJQc1fFg2YPbxvxeD')
/** pump.fun's mayhem program. Its accounts are required by `create_v2` even with mayhem off. */
export const MAYHEM = new PublicKey('MAyhSmzXzV1pTf7LsNkrNwkWKTo4ougAJ1PPg47MD4e')
/** Token-2022. Every `create_v2` coin is one of these, not a classic SPL mint. */
export const TOKEN_2022 = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb')
export const FEE_CONFIG = new PublicKey('8Wf5TiAheLUqBrKXeYg2JtAFFMWtKdG2BSFgqUcPVwTt')

/**
 * FOMO's co-signer. Every transaction the FOMO app makes carries this signature, sends included,
 * and nothing else can produce it — so a transfer into a deposit address counts only if it has
 * one. The PROGRAM never sees it: the attester (watcher/) reads it off each transfer.
 */
export const MAINNET_FOMO_COSIGNER = new PublicKey('AgmLJBMDCqWynYnQiPCuj9ewsNNsBJXyzoUhD9LJzN51')

/** Anchor's instruction discriminator. */
export const disc = (name) => Buffer.from(sha256(new TextEncoder().encode(`global:${name}`)).slice(0, 8))
/** Anchor's ACCOUNT discriminator: the first 8 bytes of every account the program owns. */
export const accountDisc = (name) => Buffer.from(sha256(new TextEncoder().encode(`account:${name}`)).slice(0, 8))
export const SALE_DISC = accountDisc('Sale')

/**
 * Is this account a Sale the program wrote, at the address the program would have put it?
 *
 * 🔴 Three checks, and every surface that shows a deposit address or acts on a sale asks all
 * three (an outside reviewer showed, 22 Sep 2026, that sale-SHAPED bytes at any address were
 * accepted — a page could have displayed an attacker's deposit account under our name):
 *  1. the account is OWNED by the program — nobody else can write one;
 *  2. it carries the Sale discriminator — not some other account of ours;
 *  3. its address IS `["sale", authority, sale_id]` — the bytes name their own address.
 * `isGenuineSale` (real USDC) is the fourth, and separate, question.
 */
export function isProgramSale(address, info, sale = null) {
  if (!info?.data || !info.owner?.equals?.(PROGRAM_ID)) return false
  if (info.data.length < 8 || !Buffer.from(info.data.subarray(0, 8)).equals(SALE_DISC)) return false
  let s = sale
  if (!s) { try { s = decodeSale(info.data) } catch { return false } }
  return saleAddress(s.authority, s.saleId).equals(new PublicKey(address))
}

const u64 = (v) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b }
const i64 = (v) => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(v)); return b }
const str = (s) => { const d = Buffer.from(s, 'utf8'); const l = Buffer.alloc(4); l.writeUInt32LE(d.length); return Buffer.concat([l, d]) }
const pdaOf = (seeds, prog = PROGRAM_ID) => PublicKey.findProgramAddressSync(seeds, prog)[0]

export const saleAddress = (authority, saleId) => pdaOf([Buffer.from('sale'), authority.toBuffer(), u64(saleId)])
export const vaultAddress = (sale) => pdaOf([Buffer.from('vault'), sale.toBuffer()])
/** The mint is seeded with a ground nonce, which is what gives it the `fomo` suffix. */
export const mintAddress = (sale, nonce) => pdaOf([Buffer.from('mint'), sale.toBuffer(), u64(nonce)])
export const positionAddress = (sale, owner) => pdaOf([Buffer.from('pos'), sale.toBuffer(), owner.toBuffer()])
/** One per transfer: credited or returned, never both, never twice. `sig` is the 64 raw bytes. */
export const receiptAddress = (sale, sig, ixIndex) =>
  pdaOf([Buffer.from('rcpt'), sale.toBuffer(), Buffer.from(sig.subarray(0, 32)), Buffer.from(sig.subarray(32, 64)), Buffer.from([ixIndex])])
/** Where buyers send from FOMO: the deposit wallet's USDC account, owned by the vault. */
export const depositAccountAddress = (depositWallet, quoteMint = USDC_MINT, tokenProgram = TOKEN_PROGRAM_ID) =>
  getAssociatedTokenAddressSync(quoteMint, depositWallet, false, tokenProgram)

const key = (pubkey, isSigner, isWritable) => ({ pubkey, isSigner, isWritable })

/**
 * What a sale can be denominated in, matching `Quote` in curve.rs.
 *
 * ⚠ USDC is 6 decimals where SOL is 9. Every amount crossing this boundary is in the quote's own
 * base units, so a lamport figure reused for a USDC sale is out by a factor of a thousand.
 */
export const QUOTE = { sol: 0, usdc: 1, usdcPair: 2 }
export const QUOTE_DECIMALS = { sol: 9, usdc: 6 }
export const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')

/**
 * ⛔⛔ Whether a sale may be shown, listed or served at all.
 *
 * The program as first deployed does not require the quote mint to BE USDC. A creator calling it
 * directly can name a mint of their own, so the deposit account holds that mint — while buyers,
 * told to "send USDC" to the deposit wallet, fill the wallet's REAL USDC account, which the creator
 * still controls. Every surface asks this before showing a deposit address or acting on a sale.
 * (Found in review 16 Sep 2026; the program upgrade adds the same rule on chain.)
 */
export const isGenuineSale = (sale) => {
  const mint = sale?.quoteMint?.toBase58 ? sale.quoteMint.toBase58() : sale?.quoteMint
  return (sale?.quoteLabel ?? (sale?.quote === 1 ? 'usdc' : null)) === 'usdc' && mint === 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
}

export function initializeSaleIx(authority, saleId, cfg) {
  const sale = saleAddress(authority, saleId)
  const vault = vaultAddress(sale)
  const data = Buffer.concat([
    disc('initialize_sale'), u64(saleId), i64(cfg.windowSeconds), i64(cfg.launchWindow),
    u64(cfg.perWalletCap), u64(cfg.hardCap), u64(cfg.minRaise),
    u64(cfg.protocolFeeBps), u64(cfg.creatorFeeBps),
    cfg.creatorFeeRecipient.toBuffer(), str(cfg.name), str(cfg.symbol), str(cfg.uri),
    // Denomination. Defaults to native SOL so every existing caller keeps working unchanged;
    // the program rejects anything it does not recognise rather than guessing.
    Buffer.from([QUOTE[cfg.quote ?? 'sol'] ?? (() => { throw new Error(`unknown quote: ${cfg.quote}`) })()]),
    // The mint a non-SOL sale settles in; all zeroes for native SOL.
    (cfg.quoteMint ?? PublicKey.default).toBuffer(),
    // ⛔ Cashback pays this coin's creator fee leg to TRADERS instead of to the creator, so it is
    // a giveaway of the sale's own revenue, not a free extra. Defaults to FALSE: it was hard
    // coded true for every quote launch, and a default that spends someone's money has to be the
    // one they would have chosen. Only `create_v2` carries the flag, so the program refuses it
    // on a SOL sale rather than recording a setting the launch could never apply.
    // pump.fun holder rewards: the creator fee leg goes to holders instead, permanently. Off by default.
    Buffer.from([cfg.holderRewards ? 1 : 0]),
  ])
  if (!cfg.depositWallet) throw new Error('depositWallet is required; see depositAccountSetupIxs')
  // A SOL sale names no quote mint; derive against USDC so the program's own refusal is what answers.
  const depositAccount = depositAccountAddress(cfg.depositWallet, cfg.quoteMint && !cfg.quoteMint.equals(PublicKey.default) ? cfg.quoteMint : USDC_MINT)
  return { sale, vault, depositAccount, ix: new TransactionInstruction({ programId: PROGRAM_ID, data, keys: [
    key(authority, true, true), key(sale, false, true), key(vault, false, true),
    key(SystemProgram.programId, false, false),
    key(cfg.depositWallet, false, false), key(depositAccount, false, false),
  ] }) }
}

/**
 * Makes a sale's deposit address: a fresh, ordinary wallet whose USDC account is created and then
 * handed to the vault. `depositWallet` must sign the hand-over, once; its key is thrown away after.
 *
 * ⭐ An ordinary wallet rather than the vault's own address because the vault is a PDA, off the
 * curve, and wallet apps' Send screens may refuse one. The token program obeys only the account's
 * OWNER, so after this the wallet's key can move nothing.
 */
export const depositAccountSetupIxs = (payer, depositWallet, vault, quoteMint = USDC_MINT) => {
  const account = depositAccountAddress(depositWallet, quoteMint)
  return [
    createAssociatedTokenAccountIdempotentInstruction(payer, account, depositWallet, quoteMint),
    createSetAuthorityInstruction(account, depositWallet, AuthorityType.AccountOwner, vault),
  ]
}

const sigBytes = (sig) => { const b = Buffer.from(sig); if (b.length !== 64) throw new Error('signature must be 64 bytes'); return b }

/** Books a FOMO-signed transfer. Attester only. */
export function creditIx(attester, sale, depositAccount, { sig, ixIndex, slot, blockTime, depositor, amount }, pool) {
  const s = sigBytes(sig)
  // ⛔ The pool is not optional. A credit is priced on the SOL curve, and the rate comes from the
  // pool the program will swap through — so the three accounts that carry that rate travel with
  // every credit. `pool` is `{ solVault, usdcVault }` as `poolVaults()` returns them.
  if (!pool?.solVault || !pool?.usdcVault) throw new Error('creditIx needs the swap pool\'s vaults')
  return new TransactionInstruction({ programId: PROGRAM_ID, keys: [
    key(attester, true, true), key(sale, false, true), key(positionAddress(sale, depositor), false, true),
    key(receiptAddress(sale, s, ixIndex), false, true), key(depositAccount, false, false),
    key(SWAP_POOL, false, false), key(pool.solVault, false, false), key(pool.usdcVault, false, false),
    key(SystemProgram.programId, false, false),
  ], data: Buffer.concat([disc('credit'), s, Buffer.from([ixIndex]), u64(slot), i64(blockTime), depositor.toBuffer(), u64(amount)]) })
}

/** Sends a transfer that does not count back to `toTokenAccount`. Attester only. */
export function returnTransferIx(attester, sale, vault, depositAccount, toTokenAccount, { sig, ixIndex, amount }, quoteMint = USDC_MINT, tokenProgram = TOKEN_PROGRAM_ID) {
  const s = sigBytes(sig)
  return new TransactionInstruction({ programId: PROGRAM_ID, keys: [
    key(attester, true, true), key(sale, false, true), key(receiptAddress(sale, s, ixIndex), false, true),
    key(vault, false, false), key(depositAccount, false, true), key(quoteMint, false, false),
    key(toTokenAccount, false, true), key(tokenProgram, false, false), key(SystemProgram.programId, false, false),
  ], data: Buffer.concat([disc('return_transfer'), s, Buffer.from([ixIndex]), u64(amount)]) })
}

export const closeCreditsIx = (attester, sale) => new TransactionInstruction({ programId: PROGRAM_ID,
  keys: [key(attester, true, false), key(sale, false, true)], data: disc('close_credits') })

/**
 * Turns the whole raise into SOL, once, after the window closes. Permissionless.
 *
 * ⚠ Raydium's own eighteen accounts ride in `remainingAccounts`, in Raydium's order — the program
 * does not re-validate them (Raydium does, against the pool), it pins WHICH pool and then checks
 * that the vault's lamports actually went up. `market` is the OpenBook account set this pool
 * trades on; every address in it is fixed, so it belongs in the lookup table.
 */
export function swapToSolIx(cranker, sale, vault, pool, market, quoteMint = USDC_MINT, tokenProgram = TOKEN_PROGRAM_ID) {
  const depositAccount = market.depositAccount
  const vaultWsol = getAssociatedTokenAddressSync(WSOL_MINT, vault, true, tokenProgram)
  const raydium = [
    tokenProgram, SWAP_POOL, market.ammAuthority, market.ammOpenOrders, market.ammTargetOrders,
    pool.solVault, pool.usdcVault, market.serumProgram, market.serumMarket, market.serumBids,
    market.serumAsks, market.serumEventQueue, market.serumCoinVault, market.serumPcVault,
    market.serumVaultSigner, depositAccount, vaultWsol, vault,
  ]
  return new TransactionInstruction({ programId: PROGRAM_ID, keys: [
    key(cranker, true, true), key(sale, false, true), key(vault, false, true),
    key(vaultWsol, false, true), key(WSOL_MINT, false, false),
    key(SWAP_POOL, false, false), key(pool.solVault, false, false), key(pool.usdcVault, false, false),
    key(RAYDIUM_AMM_V4, false, false),
    key(tokenProgram, false, false), key(ASSOCIATED_TOKEN_PROGRAM_ID, false, false),
    key(SystemProgram.programId, false, false),
    // Raydium's list, pass-through. The last one is the source owner and Raydium wants it signed —
    // it is the vault, and the program signs it with the vault's seeds.
    ...raydium.map((k, i) => key(k, false, ![0, 2, 7].includes(i))),
  ], data: disc('swap_to_sol') })
}

/**
 * Creates the coin and buys its curve with the SOL the swap returned. Permissionless.
 *
 * pump.fun's **`create_v2`** path quoted in **WSOL**: a SOL-paired curve on a Token-2022 mint,
 * then `buy_exact_sol_in`. ⛔ It used to be v1 `create`, on the reasoning that
 * `Global.whitelisted_quote_mints` holds USDC alone so WSOL could not be a quote mint. The
 * whitelist reading was right and the conclusion was wrong: WSOL never consults that list.
 *
 * ⛔⛔ **`holderRewards` changes the ACCOUNTS, not just a flag byte.** With it on, pump.fun makes
 * the curve's creator a `holder-rewards` PDA of the mint, and `creator_vault` is seeded on the
 * CURVE's creator — so passing the creator's own vault here sends the fee leg to an account
 * pump.fun will refuse. It must match what the sale recorded at open, which is why this reads it
 * rather than taking a default. Verified against mainnet coin `7mCnMuMpv…pump`.
 */
export function launchIx(cranker, sale, vault, mintNonce, creator, holderRewards = false) {
  if (mintNonce === undefined || mintNonce === null) throw new Error('launchIx needs a ground mintNonce')
  const mint = mintAddress(sale, mintNonce)
  const bondingCurve = pdaOf([Buffer.from('bonding-curve'), mint.toBuffer()], PUMP)
  // ⚠ See above: holder rewards move the curve's creator, and the vault follows it.
  const curveCreator = holderRewards
    ? pdaOf([Buffer.from('holder-rewards'), mint.toBuffer()], PUMP)
    : creator
  const creatorVault = pdaOf([Buffer.from('creator-vault'), curveCreator.toBuffer()], PUMP)
  const uva = pdaOf([Buffer.from('user_volume_accumulator'), vault.toBuffer()], PUMP)
  const solVault = pdaOf([Buffer.from('sol-vault')], MAYHEM)
  // ⭐ The coin is Token-2022, so every account FOR THE COIN derives under it. The quote side is
  // WSOL, a classic mint, so its accounts derive under the classic program. Two token programs in
  // one instruction, and swapping them yields addresses that exist but hold nothing.
  const coinAta = (owner) => getAssociatedTokenAddressSync(mint, owner, true, TOKEN_2022)

  return new TransactionInstruction({ programId: PROGRAM_ID, data: Buffer.concat([disc('launch'), u64(mintNonce)]), keys: [
    key(cranker, true, true),
    key(sale, false, true),
    key(vault, false, true),
    key(mint, false, true),
    key(coinAta(vault), false, true),

    key(pdaOf([Buffer.from('mint-authority')], PUMP), false, false),
    key(bondingCurve, false, true),
    key(coinAta(bondingCurve), false, true),
    key(pdaOf([Buffer.from('global')], PUMP), false, false),

    // the create_v2 accounts, in the order the Rust context declares them
    key(MAYHEM, false, true),
    key(pdaOf([Buffer.from('global-params')], MAYHEM), false, false),
    key(solVault, false, true),
    key(pdaOf([Buffer.from('mayhem-state'), mint.toBuffer()], MAYHEM), false, true),
    key(coinAta(solVault), false, true),
    key(WSOL_MINT, false, false),
    key(getAssociatedTokenAddressSync(WSOL_MINT, bondingCurve, true, TOKEN_PROGRAM_ID), false, true),
    key(TOKEN_PROGRAM_ID, false, false),

    key(FEE_RECIPIENT, false, true),
    key(BUYBACK, false, true),
    key(creatorVault, false, true),
    key(pdaOf([Buffer.from('global_volume_accumulator')], PUMP), false, true),
    key(uva, false, true),
    key(FEE_CONFIG, false, false),
    key(FEE_PROGRAM, false, false),
    key(pdaOf([Buffer.from('bonding-curve-v2'), mint.toBuffer()], PUMP), false, true),
    key(pdaOf([Buffer.from('__event_authority')], PUMP), false, false),
    key(PUMP, false, false),

    key(TOKEN_2022, false, false),
    key(ASSOCIATED_TOKEN_PROGRAM_ID, false, false),
    key(SystemProgram.programId, false, false),
  ] })
}

/** Pushes a launched position's tokens to its owner. Permissionless; `cranker` pays any ATA rent. */
export function distributeIx(cranker, sale, vault, mint, owner, tokenProgram = TOKEN_2022) {
  // ⛔⛔ TOKEN-2022 by default. The coin is made with pump.fun's `create_v2`, which mints there —
  // and an ATA derived under the wrong token program is a DIFFERENT ADDRESS that exists and is
  // empty, so delivery goes nowhere and the buyer holds zero with nothing having failed.
  //
  // ⚠ It was classic SPL until 21 Sep 2026, when the launch moved from v1 `create`. Any sale
  // that launched before then holds a classic coin and must pass the classic program explicitly.
  return new TransactionInstruction({ programId: PROGRAM_ID, data: disc('distribute'), keys: [
    key(cranker, true, true), key(sale, false, true), key(positionAddress(sale, owner), false, true),
    key(owner, false, false), key(vault, false, false), key(mint, false, false),
    key(getAssociatedTokenAddressSync(mint, vault, true, tokenProgram), false, true),
    key(getAssociatedTokenAddressSync(mint, owner, true, tokenProgram), false, true),
    key(tokenProgram, false, false), key(ASSOCIATED_TOKEN_PROGRAM_ID, false, false),
    key(SystemProgram.programId, false, false),
  ] })
}

/** Pushes a failed sale's deposit back to its owner's USDC account. Permissionless. */
export function refundPushIx(sale, vault, depositAccount, owner, quoteMint = USDC_MINT, tokenProgram = TOKEN_PROGRAM_ID) {
  return new TransactionInstruction({ programId: PROGRAM_ID, data: disc('refund_push'), keys: [
    key(sale, false, true), key(positionAddress(sale, owner), false, true), key(vault, false, false),
    key(depositAccount, false, true), key(quoteMint, false, false),
    key(getAssociatedTokenAddressSync(quoteMint, owner, true, tokenProgram), false, true),
    key(tokenProgram, false, false),
  ] })
}

/** The atomic launch: pump.fun `create` and `buy` in one instruction. Permissionless. */
/**
 * The quote-denominated launch: `create_v2` then `buy_v2` inside one instruction.
 *
 * ⚠ **This does not fit in a legacy transaction.** Thirty-five accounts is over a kilobyte of
 * keys on their own. Send it as a v0 transaction with the lookup table from `launchLookupTable`.
 *
 * Every derivation below was checked against a real USDC launch rather than inferred — see
 * PUMPFUN-OPTIONS.md. Two that are easy to get wrong:
 *  - `creator_vault` is seeded on the CURVE'S CREATOR, not on the buyer. They happen to be the
 *    same account in a normal pump.fun launch, so a derivation off the buyer looks correct until
 *    a launchpad separates them — which this one does.
 *  - `sharing_config` lives under the FEE program, not the pump program.
 */
/**
 * ⚠ `mintNonce` is ground by the launcher (vanity.mjs `grind`) and decides the coin's address, which
 * nobody can know before this transaction lands. Pass the nonce; the mint is derived from it.
 */

/**
 * The accounts a quote launch can put in a shared lookup table.
 *
 * Everything here is the same for every launch, which is what makes ONE table enough rather than
 * one per sale. The five that vary — the mint, its curve, that curve's two associated accounts,
 * and the vault's — stay in the transaction.
 */
export function launchLookupAddresses(quoteMint = USDC_MINT, quoteTokenProgram = TOKEN_PROGRAM_ID) {
  return [
    // ── the create_v2 launch ──
    // ⛔ No MPL and no rent sysvar: a create_v2 coin keeps its metadata in the mint's own
    // extension, so neither account appears in the instruction at all. ⛔ BOTH token programs
    // are here on purpose — Token-2022 owns the coin, classic SPL owns WSOL.
    // ⚠ WSOL is not listed here although the launch needs it: the swap section below already
    // carries it, and a table may not hold the same address twice.
    PUMP, FEE_PROGRAM, FEE_CONFIG, MAYHEM, TOKEN_2022, TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID, SystemProgram.programId,
    pdaOf([Buffer.from('global')], PUMP),
    pdaOf([Buffer.from('mint-authority')], PUMP),
    pdaOf([Buffer.from('__event_authority')], PUMP),
    pdaOf([Buffer.from('global_volume_accumulator')], PUMP),
    pdaOf([Buffer.from('global-params')], MAYHEM),
    pdaOf([Buffer.from('sol-vault')], MAYHEM),
    FEE_RECIPIENT, BUYBACK,
    // the swap that funds it
    RAYDIUM_AMM_V4, SWAP_POOL, WSOL_MINT, quoteMint,
    SWAP_POOL_VAULTS.solVault, SWAP_POOL_VAULTS.usdcVault,
    ...Object.values(SWAP_MARKET),
  ]
}

/** Claiming a Token-2022 coin from a quote sale. */
/**
 * Claiming a Token-2022 coin from a quote sale.
 *
 * `overrides` exists so a suite can substitute a hostile account and prove the program refuses it.
 * `claim` had a real vulnerability of exactly this shape — both token accounts were unchecked, and
 * a claimer could name any other token account the vault owned and drain it up to their allocation.
 * The same attack has to be provable against this instruction, not assumed to be closed because
 * the constraints look similar.
 */
export function claimQuoteIx(claimer, sale, vault, mint, overrides = {}) {
  const position = positionAddress(sale, claimer)
  const o = overrides
  return { position, ix: new TransactionInstruction({
    programId: PROGRAM_ID, data: disc('claim_quote'), keys: [
      key(claimer, true, true), key(sale, false, true), key(o.position ?? position, false, true),
      key(vault, false, false), key(o.mint ?? mint, false, false),
      key(o.vaultTokenAccount ?? getAssociatedTokenAddressSync(mint, vault, true, TOKEN_2022), false, true),
      key(o.claimerTokenAccount ?? getAssociatedTokenAddressSync(mint, claimer, false, TOKEN_2022), false, true),
      key(TOKEN_2022, false, false),
    ] }) }
}

/** Returning a quote-token deposit after a failed sale. */
export function refundQuoteIx(depositor, sale, vault, quoteMint, tokenProgram = TOKEN_PROGRAM_ID, depositAccount = null) {
  const position = positionAddress(sale, depositor)
  return { position, ix: new TransactionInstruction({
    programId: PROGRAM_ID, data: disc('refund_quote'), keys: [
      key(depositor, true, true), key(sale, false, true), key(position, false, true),
      key(vault, false, false), key(quoteMint, false, false),
      // The deposits sit in the sale's deposit account, which the vault owns.
      key(depositAccount ?? getAssociatedTokenAddressSync(quoteMint, vault, true, tokenProgram), false, true),
      key(getAssociatedTokenAddressSync(quoteMint, depositor, false, tokenProgram), false, true),
      key(tokenProgram, false, false),
    ] }) }
}

/**
 * Refunds a failed sale whose raise had already been swapped to SOL — in SOL, pro rata. The pair
 * account rides along for a pair sale (the program refuses once the SOL went on into the pair
 * token); for any other sale the slot carries the sale itself and is ignored.
 */
export function refundSolIx(sale, vault, owner, pair = null) {
  return new TransactionInstruction({ programId: PROGRAM_ID, data: disc('refund_sol'), keys: [
    key(sale, false, true), key(positionAddress(sale, owner), false, true), key(owner, false, true),
    key(vault, false, true), key(pair ?? sale, false, false), key(SystemProgram.programId, false, false),
  ] })
}

/** Refunds a failed pair sale whose SOL had gone on into the pair token — in that token, pro rata. */
export function refundPairIx(cranker, sale, vault, pair, owner) {
  const { mint, tokenProgram } = pair
  return new TransactionInstruction({ programId: PROGRAM_ID, data: disc('refund_pair'), keys: [
    key(cranker, true, true), key(sale, false, true), key(positionAddress(sale, owner), false, true),
    key(pairAddress(sale), false, true), key(owner, false, false), key(vault, false, false), key(mint, false, false),
    key(getAssociatedTokenAddressSync(mint, vault, true, tokenProgram), false, true),
    key(getAssociatedTokenAddressSync(mint, owner, true, tokenProgram), false, true),
    key(tokenProgram, false, false), key(ASSOCIATED_TOKEN_PROGRAM_ID, false, false),
    key(SystemProgram.programId, false, false),
  ] })
}

export const failSaleIx = (sale) => new TransactionInstruction({
  programId: PROGRAM_ID, data: disc('fail_sale'), keys: [key(sale, false, true)] })

export const sweepLamportsIx = (authority, sale, vault) => new TransactionInstruction({
  programId: PROGRAM_ID, data: disc('sweep_lamports'), keys: [
    key(authority, true, true), key(sale, false, true), key(vault, false, true),
    key(SystemProgram.programId, false, false),
  ] })

/* ------------------------------------------------------------------ custom pairs
 *
 * A coin paired with one of pump.fun's custom liquidity tokens. See programs/…/src/pair.rs.
 * Buyers pay USDC exactly as before; at the close the SOL from `swap_to_sol` is swapped into the
 * pair token through Jupiter (attester only), and `launch_pair` makes the same `create_v2` pump.fun's
 * own form sends for a custom pair.
 */

/** pump.fun's custom-pair allowlist, PDA ["quote-control"] of pump.fun. */
export const QUOTE_CONTROL = new PublicKey('6z6GDdfb2AjR9ZhJmAUQ5cipJCVxQvLJhB2H8mCwTFBP')
export const JUPITER = new PublicKey('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4')
/** pump.fun's own ceiling for a custom pair's creator fee (Global.max_configurable_creator_fee_bps). */
export const MAX_PAIR_CREATOR_FEE_BPS = 300
export const pairAddress = (sale) => pdaOf([Buffer.from('pair'), sale.toBuffer()])

/** Every mint on pump.fun's custom-pair list, with the opening virtual reserve pump.fun gives it. */
export function decodeQuoteControl(data) {
  let o = 8 + 32 + 64
  const n = data.readUInt32LE(o); o += 4
  const out = []
  for (let i = 0; i < n; i++, o += 40) {
    out.push({ mint: new PublicKey(data.subarray(o, o + 32)), initialVirtualQuote: data.readBigUInt64LE(o + 32) })
  }
  return out
}
export const readPairList = async (conn) => {
  const info = await conn.getAccountInfo(QUOTE_CONTROL)
  if (!info) throw new Error('pump.fun\'s quote-control account is not readable on this cluster')
  return decodeQuoteControl(info.data)
}

export const decodePair = (d) => ({
  sale: new PublicKey(d.subarray(8, 40)), mint: new PublicKey(d.subarray(40, 72)),
  tokenProgram: new PublicKey(d.subarray(72, 104)),
  creatorFeeBps: Number(d.readBigUInt64LE(104)), pairIn: d.readBigUInt64LE(112),
})
export async function readPair(conn, sale, commitment = 'confirmed') {
  const info = await conn.getAccountInfo(pairAddress(sale), commitment)
  return info ? decodePair(info.data) : null
}

/** Names a sale's pair token and creator fee. Sent in the SAME transaction as `initialize_sale`. */
export function setPairIx(authority, sale, pairMint, creatorFeeBps = 0) {
  if (!(creatorFeeBps >= 0 && creatorFeeBps <= MAX_PAIR_CREATOR_FEE_BPS)) throw new Error(`creator fee must be 0..${MAX_PAIR_CREATOR_FEE_BPS} bps`)
  return new TransactionInstruction({ programId: PROGRAM_ID, data: Buffer.concat([disc('set_pair'), u64(creatorFeeBps)]), keys: [
    key(authority, true, true), key(sale, false, true), key(pairAddress(sale), false, true),
    key(pairMint, false, false), key(QUOTE_CONTROL, false, false), key(SystemProgram.programId, false, false),
  ] })
}

/**
 * SOL → pair token, through Jupiter. Attester only.
 *
 * `route` is Jupiter's `swapInstruction` from `/swap-instructions`, built for `userPublicKey = vault`
 * with `useSharedAccounts` and `wrapAndUnwrapSol: false` — the program wraps the SOL itself.
 * Its accounts pass through unchanged except the vault, which the program signs for.
 */
export function swapToPairIx(attester, sale, vault, depositAccount, pair, route, minOut) {
  const data = Buffer.from(route.data, 'base64')
  const len = Buffer.alloc(4); len.writeUInt32LE(data.length)
  return new TransactionInstruction({ programId: PROGRAM_ID,
    data: Buffer.concat([disc('swap_to_pair'), len, data, u64(minOut)]), keys: [
      key(attester, true, true), key(sale, false, false), key(pairAddress(sale), false, true),
      key(vault, false, true), key(depositAccount, false, false),
      key(getAssociatedTokenAddressSync(WSOL_MINT, vault, true, TOKEN_PROGRAM_ID), false, true), key(WSOL_MINT, false, false),
      key(getAssociatedTokenAddressSync(pair.mint, vault, true, pair.tokenProgram), false, true), key(pair.mint, false, false),
      key(QUOTE_CONTROL, false, false), key(JUPITER, false, false),
      key(TOKEN_PROGRAM_ID, false, false), key(pair.tokenProgram, false, false),
      key(ASSOCIATED_TOKEN_PROGRAM_ID, false, false), key(SystemProgram.programId, false, false),
      ...route.accounts.map((a) => {
        const pk = new PublicKey(a.pubkey)
        // The vault cannot sign the outer transaction; the program signs it by seeds.
        return key(pk, false, a.isWritable || pk.equals(vault))
      }),
    ] })
}

/**
 * Asks Jupiter for the whole-SOL swap into the pair token, for a vault.
 * Returns `{ route, minOut, lookupTables, quote }`. `minOut` is Jupiter's own floor at `slippageBps`.
 */
/** Jupiter's keyless API answers `429 Rate limit exceeded` in plain text; wait and ask again. */
async function jupiterJson(url, init, tries = 6) {
  for (let i = 0; ; i++) {
    const r = await fetch(url, init)
    if (r.status === 429 && i < tries) { await new Promise((ok) => setTimeout(ok, 1500 * (i + 1))); continue }
    const text = await r.text()
    try { return JSON.parse(text) } catch { throw new Error(`Jupiter answered ${r.status}: ${text.slice(0, 120)}`) }
  }
}

export async function jupiterPairRoute(vault, pair, lamports, { slippageBps = 100, api = 'https://lite-api.jup.ag/swap/v1', query = '' } = {}) {
  const q = await jupiterJson(`${api}/quote?inputMint=${WSOL_MINT}&outputMint=${pair.mint}&amount=${lamports}&slippageBps=${slippageBps}&swapMode=ExactIn${query}`)
  if (q.error || !q.outAmount) throw new Error(`Jupiter quote failed: ${q.error ?? JSON.stringify(q).slice(0, 200)}`)
  const r = await jupiterJson(`${api}/swap-instructions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
    quoteResponse: q, userPublicKey: vault.toBase58(), wrapAndUnwrapSol: false, useSharedAccounts: true,
    skipUserAccountsRpcCalls: true,
    destinationTokenAccount: getAssociatedTokenAddressSync(pair.mint, vault, true, pair.tokenProgram).toBase58(),
  }) })
  if (r.error || !r.swapInstruction) throw new Error(`Jupiter swap-instructions failed: ${r.error ?? JSON.stringify(r).slice(0, 200)}`)
  return { route: r.swapInstruction, minOut: BigInt(q.otherAmountThreshold), lookupTables: r.addressLookupTableAddresses ?? [], quote: q }
}

/**
 * The pair launch: `create_v2` against the pair token + `buy_exact_quote_in_v2`. Permissionless.
 * `pair` is `readPair()`'s result. The 27 buy accounts ride as remaining accounts, pump.fun's order.
 */
export function launchPairIx(cranker, sale, vault, mintNonce, creator, holderRewards, pair) {
  if (mintNonce === undefined || mintNonce === null) throw new Error('launchPairIx needs a ground mintNonce')
  const mint = mintAddress(sale, mintNonce)
  const bondingCurve = pdaOf([Buffer.from('bonding-curve'), mint.toBuffer()], PUMP)
  const curveCreator = holderRewards ? pdaOf([Buffer.from('holder-rewards'), mint.toBuffer()], PUMP) : creator
  const creatorVault = pdaOf([Buffer.from('creator-vault'), curveCreator.toBuffer()], PUMP)
  const uva = pdaOf([Buffer.from('user_volume_accumulator'), vault.toBuffer()], PUMP)
  const solVault = pdaOf([Buffer.from('sol-vault')], MAYHEM)
  const coinAta = (owner) => getAssociatedTokenAddressSync(mint, owner, true, TOKEN_2022)
  const pairAta = (owner) => getAssociatedTokenAddressSync(pair.mint, owner, true, pair.tokenProgram)
  const eventAuthority = pdaOf([Buffer.from('__event_authority')], PUMP)
  const global = pdaOf([Buffer.from('global')], PUMP)

  const buy = [
    key(global, false, false), key(mint, false, false), key(pair.mint, false, false),
    key(TOKEN_2022, false, false), key(pair.tokenProgram, false, false), key(ASSOCIATED_TOKEN_PROGRAM_ID, false, false),
    key(FEE_RECIPIENT, false, true), key(pairAta(FEE_RECIPIENT), false, true),
    key(BUYBACK, false, true), key(pairAta(BUYBACK), false, true),
    key(bondingCurve, false, true), key(coinAta(bondingCurve), false, true), key(pairAta(bondingCurve), false, true),
    key(vault, false, true), key(coinAta(vault), false, true), key(pairAta(vault), false, true),
    key(creatorVault, false, true), key(pairAta(creatorVault), false, true),
    key(pdaOf([Buffer.from('sharing-config'), mint.toBuffer()], FEE_PROGRAM), false, false),
    key(pdaOf([Buffer.from('global_volume_accumulator')], PUMP), false, false),
    key(uva, false, true), key(pairAta(uva), false, true),
    key(FEE_CONFIG, false, false), key(FEE_PROGRAM, false, false), key(SystemProgram.programId, false, false),
    key(eventAuthority, false, false), key(PUMP, false, false),
  ]
  return new TransactionInstruction({ programId: PROGRAM_ID, data: Buffer.concat([disc('launch_pair'), u64(mintNonce)]), keys: [
    key(cranker, true, true), key(sale, false, true), key(pairAddress(sale), false, false),
    key(vault, false, true), key(mint, false, true), key(coinAta(vault), false, true), key(pairAta(vault), false, true),
    key(pdaOf([Buffer.from('mint-authority')], PUMP), false, false),
    key(bondingCurve, false, true), key(coinAta(bondingCurve), false, true), key(global, false, false),
    key(MAYHEM, false, true), key(pdaOf([Buffer.from('global-params')], MAYHEM), false, false),
    key(solVault, false, true), key(pdaOf([Buffer.from('mayhem-state'), mint.toBuffer()], MAYHEM), false, true),
    key(coinAta(solVault), false, true),
    key(pair.mint, false, false), key(pairAta(bondingCurve), false, true), key(pair.tokenProgram, false, false),
    key(QUOTE_CONTROL, false, false),
    key(eventAuthority, false, false), key(PUMP, false, false),
    key(TOKEN_2022, false, false), key(ASSOCIATED_TOKEN_PROGRAM_ID, false, false), key(SystemProgram.programId, false, false),
    ...buy,
  ] })
}

/* ------------------------------------------------------------------ decoding */

export const SALE_STATUS = ['Open', 'Launched', 'Failed']

export function decodeSale(data) {
  let o = 8
  const pk = () => { const v = new PublicKey(data.subarray(o, o + 32)); o += 32; return v }
  const n64 = () => { const v = data.readBigUInt64LE(o); o += 8; return v }
  const s64 = () => { const v = data.readBigInt64LE(o); o += 8; return v }
  const n128 = () => { const v = data.readBigUInt64LE(o) + (data.readBigUInt64LE(o + 8) << 64n); o += 16; return v }
  const out = {
    authority: pk(), creatorFeeRecipient: pk(), mint: pk(), saleId: n64(),
    windowEnd: s64(), launchDeadline: s64(), perWalletCap: n64(), hardCap: n64(), minRaise: n64(),
    virtualSol: n128(), virtualToken: n128(), sold: n64(), curveIn: n64(), feeHeld: n64(),
    // ⚠ `gross` is USDC — what buyers sent, and what a refund returns. Everything else here that
    // talks about money is LAMPORTS: the curve is the SOL curve. `solExpected` is what the shadow
    // curve consumed at the pool's quoted rate, `solIn` is what the swap actually returned, and
    // the gap between them is the swap's cost, spread over everyone by `distribute`.
    gross: n64(), solExpected: n64(), solIn: n64(),
    depositors: (() => { const v = data.readUInt32LE(o); o += 4; return v })(),
    tokensReceived: n64(), claimedTotal: n64(), reserve: n64(),
    protocolFeeBps: n64(), creatorFeeBps: n64(),
    mintNonce: n64(),
    // ⚠ Order matters and is not obvious: quote_mint and quote sit between mint_nonce and
    // status, NOT beside `mint` at the top. Decoding them there shifts every field after it and
    // the sale reads as plausible nonsense — 408 SOL raised, 3 tokens sold — rather than failing.
    quoteMint: pk(),
    quote: data[o++],
    holderRewards: data[o++] === 1,
    status: data[o++],
  }
  o += 3 // bump, vault_bump, mint_bump
  const rstr = () => { const n = data.readUInt32LE(o); o += 4; const v = data.subarray(o, o + n).toString('utf8'); o += n; return v }
  out.name = rstr(); out.symbol = rstr(); out.uri = rstr()
  out.depositWallet = pk(); out.depositAccount = pk(); out.returned = n64(); out.lastCreditSlot = n64()
  out.creditsClosed = data[o++] === 1
  out.statusLabel = SALE_STATUS[out.status] ?? 'Unknown'
  // ⭐ 2 is a USDC sale whose coin launches paired with a custom liquidity token (`set_pair`).
  // Buyers still send USDC, so its DEPOSIT label is 'usdc' — `isGenuineSale` and every deposit
  // surface keep working. `pair` says the launch differs; `readPair` says against what.
  out.pair = out.quote === 2
  out.quoteLabel = ['sol', 'usdc', 'usdc'][out.quote] ?? 'unknown'
  out.quoteDecimals = QUOTE_DECIMALS[out.quoteLabel] ?? 9
  return out
}

export const decodePosition = (d) => ({
  sale: new PublicKey(d.subarray(8, 40)), owner: new PublicKey(d.subarray(40, 72)),
  // ⚠ `deposited` is USDC and `solEquiv` is what that was worth in lamports when it was booked.
  // `allocation` is the QUOTED token count — what is delivered is that scaled by
  // `tokensReceived / sold`, because the swap decides how much of the curve the raise bought.
  deposited: d.readBigUInt64LE(72), solEquiv: d.readBigUInt64LE(80),
  allocation: d.readBigUInt64LE(88), claimed: !!d[96],
})

/** What a position is actually owed, once the sale has launched. The program's own arithmetic. */
export const deliverable = (position, sale) =>
  sale.sold > 0n ? (position.allocation * sale.tokensReceived) / sale.sold : 0n

/* ------------------------------------------------------------------ transactions
 *
 * The browser and the test suite build transactions through these, not by assembling instructions
 * at each call site. A transaction that only exists inside a click handler cannot be tested
 * without a wallet; pulled out here, the exact bytes the browser would hand to a wallet can be
 * signed by a keypair in a test and proven to land.
 */

async function finish(conn, payer, ixs) {
  const tx = new Transaction().add(...ixs)
  tx.feePayer = payer
  tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash
  return tx
}

/**
 * Opening a sale, from any wallet. Returns the transaction with the throwaway deposit wallet's
 * signature ALREADY on it, so the creator's wallet only adds its own.
 *
 * `depositWallet` is a Keypair made for this one sale; nothing needs it afterwards.
 */
export async function buildInitializeSaleTx(conn, authority, saleId, cfg, depositWallet) {
  const sale = saleAddress(authority, saleId)
  const vault = vaultAddress(sale)
  const setup = depositAccountSetupIxs(authority, depositWallet.publicKey, vault, cfg.quoteMint ?? USDC_MINT)
  const { depositAccount, ix } = initializeSaleIx(authority, saleId, { ...cfg, depositWallet: depositWallet.publicKey })
  // ⭐ A custom pair is named in the SAME transaction, so the sale never exists without it.
  const pair = cfg.pairMint ? [setPairIx(authority, sale, new PublicKey(cfg.pairMint), cfg.pairCreatorFeeBps ?? 0)] : []
  const tx = await finish(conn, authority, [...setup, ix, ...pair])
  tx.partialSign(depositWallet)
  return { sale, vault, depositAccount, tx }
}

/* ---------------------------------------------------------------- the quote path
 *
 * The same four actions for a sale denominated in a quote token. They exist separately for the
 * reason the instructions do: the money moves between token accounts rather than as lamports, so
 * the accounts differ, and a builder that branched internally would be one signature away from
 * sending the wrong shape.
 *
 * ⚠ Every amount here is in the QUOTE's base units. USDC is 6 decimals where SOL is 9.
 */

/** Creates the claimer's Token-2022 account in the same transaction when they lack one. */
/**
 * Returns a sale's unspent launch reserve to its creator.
 *
 * The creator prefunds `LAUNCH_RESERVE` (0.045 SOL) when they open a sale, so that a
 * permissionless cranker never pays for the launch out of pocket and no buyer's money is ever
 * spent on rent. A `create_v2` launch consumes about 0.0072 of it; a sale that never launched
 * consumes none. This is how the remainder comes back.
 *
 * ⛔ The program refuses unless the sale has LAUNCHED, or failed with nothing left owed — so this
 * can never take money that is still someone's refund.
 *
 * ⚠ The vault keeps its rent-exempt floor and stays alive: it is the transfer authority for any
 * delivery that has not happened yet.
 */
export async function buildSweepLamportsTx(conn, authority, sale, vault) {
  return finish(conn, authority, [sweepLamportsIx(authority, sale, vault)])
}

export async function buildClaimQuoteTx(conn, payer, sale, vault, mint) {
  const ata = getAssociatedTokenAddressSync(mint, payer, false, TOKEN_2022)
  const ixs = []
  if (!(await conn.getAccountInfo(ata))) {
    ixs.push(createAssociatedTokenAccountIdempotentInstruction(payer, ata, payer, mint, TOKEN_2022))
  }
  ixs.push(claimQuoteIx(payer, sale, vault, mint).ix)
  return finish(conn, payer, ixs)
}

export async function buildRefundQuoteTx(conn, payer, sale, vault, quoteMint, depositAccount, tokenProgram = TOKEN_PROGRAM_ID) {
  const ata = getAssociatedTokenAddressSync(quoteMint, payer, false, tokenProgram)
  const ixs = []
  if (!(await conn.getAccountInfo(ata))) {
    ixs.push(createAssociatedTokenAccountIdempotentInstruction(payer, ata, payer, quoteMint, tokenProgram))
  }
  ixs.push(refundQuoteIx(payer, sale, vault, quoteMint, tokenProgram, depositAccount).ix)
  return finish(conn, payer, ixs)
}

/**
 * The quote launch. **A VersionedTransaction, not a Transaction.**
 *
 * ⛔ This one cannot be built as a legacy transaction at all: thirty accounts is close to a
 * kilobyte of keys before any data, against a 1,232-byte limit. With the shared lookup table it
 * serialises well under it. `launchLookupAddresses()` returns the 33 accounts that are identical
 * for every launch, so ONE table on chain serves them all — it is deployment infrastructure, not
 * something to create per launch, and this throws rather than guessing if it is missing.
 */
export async function buildLaunchTx(conn, payer, sale, vault, mintNonce, creator, lookupTable, holderRewards = false) {
  if (!lookupTable) throw new Error('A launch needs the shared address lookup table; none is configured.')
  const lut = (await conn.getAddressLookupTable(new PublicKey(lookupTable))).value
  if (!lut) throw new Error(`The lookup table ${lookupTable} does not exist on this cluster.`)

  const ix = launchIx(payer, sale, vault, mintNonce, creator, holderRewards)
  const msg = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: (await conn.getLatestBlockhash()).blockhash,
    // 600k: `create_v2` opens a Token-2022 mint plus the curve's WSOL account, and the buy walks
    // pump.fun's fee program.
    instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }), ix],
  }).compileToV0Message([lut])
  return new VersionedTransaction(msg)
}

/** Exactly what `signAndSendTransaction` receives: the wire bytes, unsigned. */
export const serializeForWallet = (tx) =>
  new Uint8Array(tx.serialize({ requireAllSignatures: false, verifySignatures: false }))

/* ------------------------------------------------------- sharing creator rewards
 *
 * pump.fun's "Share creator rewards": the creator's fee leg is split between several wallets by
 * basis points instead of all going to one address.
 *
 * ⛔ **It is not a `create` argument.** Nothing in the bonding-curve program writes it — every
 * instruction there only READS a `SharingConfig`. The feature lives in a SEPARATE program, the
 * same fee program that answers `get_fees`: `pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ`. So it
 * is TWO transactions AFTER the coin exists, not a flag at launch — the create form's "your split
 * is applied when you create the coin" describes its own UI, not the chain.
 *
 * The flow:
 *   1. `create_fee_sharing_config` — creates `SharingConfig` PDA ["sharing-config", mint] and
 *      repoints the bonding curve's creator at it, so later fees accrue to the sharing vault.
 *   2. `update_fee_shares_v2` — writes the shareholders. Shares are BASIS POINTS and must total
 *      exactly 10,000; duplicates are rejected.
 *   3. `distribute_creator_fees` (in the pump program) splits the vault out to them. It takes no
 *      signer, so anyone can trigger a distribution.
 *
 * ⚠ Ordering matters for money: fees earned before step 1 accrue to the ORIGINAL creator's vault
 * and stay there. Sharing set up late does not retroactively split anything.
 *
 * ⚠ `revoke_fee_sharing_authority` makes the split permanent — pump.fun's "rewards sharing cannot
 * be changed again". It is NOT encoded here: its accounts list is empty in the on-chain IDL, so
 * there is nothing to build an instruction from without guessing, and guessing at an irreversible
 * instruction is the wrong trade. Note the program already errors `SharingConfigAdminRevoked`
 * with "sharing config can only be updated once".
 */
export const AMM_PROGRAM = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA')
export const sharingConfigAddress = (mint) =>
  pdaOf([Buffer.from('sharing-config'), mint.toBuffer()], FEE_PROGRAM)

/** Step 1. Creates the sharing config and repoints the curve's creator at it. */
export function createFeeSharingConfigIx(payer, mint) {
  const sharingConfig = sharingConfigAddress(mint)
  return { sharingConfig, ix: new TransactionInstruction({
    programId: FEE_PROGRAM,
    data: Buffer.from([195, 78, 86, 76, 111, 52, 251, 213]),
    keys: [
      key(pdaOf([Buffer.from('__event_authority')], FEE_PROGRAM), false, false),
      key(FEE_PROGRAM, false, false),
      key(payer, true, true),
      key(pdaOf([Buffer.from('global')], PUMP), false, false),
      key(mint, false, false),
      key(sharingConfig, false, true),
      key(SystemProgram.programId, false, false),
      key(pdaOf([Buffer.from('bonding-curve'), mint.toBuffer()], PUMP), false, true),
      key(PUMP, false, false),
      key(pdaOf([Buffer.from('__event_authority')], PUMP), false, false),
      // `pool` is optional and only exists once a coin has graduated to the AMM. Anchor's
      // convention for an absent optional account is the PROGRAM ID in its place.
      key(FEE_PROGRAM, false, false),
      key(AMM_PROGRAM, false, false),
      key(pdaOf([Buffer.from('__event_authority')], AMM_PROGRAM), false, false),
    ] }) }
}

/**
 * Step 2. Writes the split.
 *
 * ⚠ `shareholders` is `[{ address, shareBps }]` and the bps MUST total exactly 10,000 — the
 * program rejects anything else with `InvalidShareTotal`, and duplicates with
 * `DuplicateShareholder`. Checked here first so a wallet is never asked to sign a doomed
 * transaction.
 */
export function updateFeeSharesIx(authority, mint, shareholders, quoteMint, tokenProgram = TOKEN_PROGRAM_ID, remainingAccounts = null) {
  if (!remainingAccounts) {
    throw new Error(
      'update_fee_shares_v2 needs an explicit remainingAccounts layout; none is verified. ' +
      'See the note in program.mjs — five layouts were tried and rejected, and guessing here ' +
      'writes an irreversible split.')
  }
  const total = shareholders.reduce((n, s) => n + Number(s.shareBps), 0)
  if (total !== 10_000) throw new Error(`shares must total 10000 bps, got ${total}`)
  const seen = new Set()
  for (const s of shareholders) {
    const k = s.address.toBase58()
    if (seen.has(k)) throw new Error(`duplicate shareholder ${k}`)
    seen.add(k)
  }

  const sharingConfig = sharingConfigAddress(mint)
  const pumpCreatorVault = pdaOf([Buffer.from('creator-vault'), sharingConfig.toBuffer()], PUMP)
  // ⚠ The AMM's seed is `creator_vault` with an UNDERSCORE where pump's is `creator-vault` with a
  // hyphen. They are different addresses and the two are easy to transpose.
  const ammCreatorVaultAuthority = pdaOf([Buffer.from('creator_vault'), sharingConfig.toBuffer()], AMM_PROGRAM)

  const data = Buffer.concat([
    Buffer.from([111, 251, 49, 6, 78, 78, 106, 18]),
    (() => { const n = Buffer.alloc(4); n.writeUInt32LE(shareholders.length); return n })(),
    ...shareholders.map((s) => {
      const bps = Buffer.alloc(2); bps.writeUInt16LE(Number(s.shareBps))
      return Buffer.concat([s.address.toBuffer(), bps])
    }),
  ])

  return { sharingConfig, ix: new TransactionInstruction({
    programId: FEE_PROGRAM, data, keys: [
      key(pdaOf([Buffer.from('__event_authority')], FEE_PROGRAM), false, false),
      key(FEE_PROGRAM, false, false),
      key(authority, true, true),
      key(pdaOf([Buffer.from('global')], PUMP), false, false),
      key(mint, false, false),
      key(sharingConfig, false, true),
      key(pdaOf([Buffer.from('bonding-curve'), mint.toBuffer()], PUMP), false, false),
      key(pumpCreatorVault, false, true),
      key(getAssociatedTokenAddressSync(quoteMint, pumpCreatorVault, true, tokenProgram), false, true),
      key(SystemProgram.programId, false, false),
      key(PUMP, false, false),
      key(pdaOf([Buffer.from('__event_authority')], PUMP), false, false),
      key(AMM_PROGRAM, false, false),
      key(pdaOf([Buffer.from('__event_authority')], AMM_PROGRAM), false, false),
      key(quoteMint, false, false),
      key(tokenProgram, false, false),
      key(ASSOCIATED_TOKEN_PROGRAM_ID, false, false),
      key(ammCreatorVaultAuthority, false, true),
      key(getAssociatedTokenAddressSync(quoteMint, ammCreatorVaultAuthority, true, tokenProgram), false, true),
      // ⚠ The shareholders are REMAINING ACCOUNTS, one per entry and in the same order as the
      // argument — the IDL's list stops above, and omitting them fails with
      // `NotEnoughRemainingAccounts`, which names no shareholder.
      //
      // ⛔⛔ UNRESOLVED — the caller must supply this slice explicitly, and there is no default.
      //
      // `update_fee_shares_v2` takes remaining accounts the IDL does not describe, and it CPIs into
      // pump's `distribute_creator_fees_v2` to flush fees accrued under the split being replaced.
      // The slice therefore has to satisfy the fee program's check against the NEW list and the
      // pump program's check against the OLD one at the same time. Five layouts were tried against
      // a real launched coin and every one was rejected:
      //
      //   new shareholders             -> ShareholderAccountMismatch          (fee :212)
      //   their token accounts         -> ShareholderAccountMismatch          (fee :212)
      //   current shareholders only    -> NotEnoughRemainingAccounts          (fee :210)
      //   new then current             -> ShareholdersAndRemainingAccountsMismatch (pump distribute :112)
      //   current then new             -> ShareholdersAndRemainingAccountsMismatch (pump distribute :112)
      //
      // ⚠ The last was also tried on a coin with ZERO accrued fees, so the distribute check is
      // unconditional rather than balance-dependent.
      //
      // ⛔ There is no default here ON PURPOSE. This writes an irreversible split of someone's
      // revenue, and a plausible guess that lands is worse than one that fails. Supply the layout
      // once it has been read off a real mainnet `update_fee_shares_v2` transaction — the method
      // that settled `create_v2`'s account list. As of 28 Aug 2026 the feature is too new to find
      // one: 200 sampled fee-program transactions contained only `get_fees`, and
      // `getProgramAccounts` is 403-blocked on both available endpoints.
      //
      // `update_fee_shares_v2` first CPIs into pump's `distribute_creator_fees_v2` to flush
      // whatever the sharing vault has accrued to the split that is being replaced — otherwise a
      // change of split would silently redirect fees already earned under the old one. So the
      // remaining accounts must match the config as it stands ON CHAIN, in order, or it fails
      // with `ShareholdersAndRemainingAccountsMismatch` from inside the pump program — an error
      // that names the callee and gives no hint that the list wanted is the OLD one.
      //
      // A freshly created config already holds one recipient: the creator at 100%. So the first
      // update passes THAT, not the split being written.
      //
      // ⚠ Each wallet must already EXIST on chain. A never-funded address fails with
      // `InvalidAccountData`, which reads like a malformed instruction rather than what it is.
      ...remainingAccounts.map((a) => key(a, false, true)),
    ] }) }
}

/** Reads a live SharingConfig, or null if the coin has none. */
export async function readSharingConfig(conn, mint) {
  const info = await conn.getAccountInfo(sharingConfigAddress(mint))
  if (!info || info.data.length === 0) return null
  const d = info.data
  let o = 8
  const bump = d[o++], version = d[o++], status = d[o++]
  const configMint = new PublicKey(d.subarray(o, o + 32)); o += 32
  const admin = new PublicKey(d.subarray(o, o + 32)); o += 32
  const adminRevoked = d[o++] === 1
  const n = d.readUInt32LE(o); o += 4
  const shareholders = []
  for (let i = 0; i < n; i++) {
    shareholders.push({
      address: new PublicKey(d.subarray(o, o + 32)),
      shareBps: d.readUInt16LE(o + 32),
    })
    o += 34
  }
  return { bump, version, status, mint: configMint, admin, adminRevoked, shareholders }
}
