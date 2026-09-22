/**
 * The attester and the keeper — what turns USDC sent from FOMO into positions, and positions into
 * tokens in people's wallets.
 *
 * ## The one judgement it makes
 *
 * A transfer into a sale's deposit account COUNTS if and only if FOMO's co-signer signed the
 * transaction that made it. FOMO puts that signature on everything its app sends, and nothing
 * else can produce it. The program cannot check this itself — it cannot read the signers of an
 * earlier transaction — which is why this exists and why the program trusts `ATTESTER` for it.
 *
 * Everything that counts and fits is `credit`ed, in chain order. Everything else — not from FOMO,
 * late, below the floor, past a cap — is `return_transfer`ed to the sender's own USDC account.
 * Each is done at most once, enforced on chain by a receipt keyed on the transfer's signature.
 *
 * ## The keeper half needs no trust
 *
 * `crankSale` only calls permissionless instructions: launch or fail once credits are settled,
 * then push tokens or refunds to every position. Anyone could run it.
 */
import {
  PublicKey, Transaction, TransactionMessage, VersionedTransaction, ComputeBudgetProgram,
  sendAndConfirmTransaction,
} from '@solana/web3.js'
import { getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import bs58 from 'bs58'
import { grind } from '../vanity.mjs'
import {
  USDC_MINT, decodeSale, decodePosition, vaultAddress, receiptAddress, positionAddress, isGenuineSale,
  creditIx, returnTransferIx, closeCreditsIx, launchIx, swapToSolIx, failSaleIx, distributeIx,
  readPair, swapToPairIx, launchPairIx, jupiterPairRoute,
  refundPushIx, refundSolIx, refundPairIx, pairAddress, saleAddress, PROGRAM_ID, SALE_DISC,
  RPC_BATCH, SWAP_POOL, SWAP_MARKET, poolVaults,
} from '../program.mjs'

/** Program errors that mean "this transfer does not fit", so it goes back rather than retrying. */
const DOES_NOT_FIT = [
  'DepositBelowMinimum', 'PerWalletCapExceeded', 'HardCapExceeded', 'WalletAllocationCapExceeded',
  'CurveExhausted', 'DepositTooSmall', 'WindowClosed', 'CreditsClosed', 'SaleNotOpen',
]
// ⛔ NOT `SlotOutOfOrder`. It only happens when an earlier transfer was skipped, and treating it as
// "does not fit" refunded a valid FOMO buy after a one-pass RPC gap (review, 16 Sep 2026). It now
// stops the pass so the earlier transfer is decided first.

/** Returns per sender for sends that did not come from FOMO. Beyond this they are left in place. */
const MAX_FOREIGN_RETURNS_PER_SENDER = 3
const MAX_NAME = 32, MAX_SYMBOL = 10, MAX_URI = 200
/** `Sale::SIZE` in lib.rs — every sale account is allocated at exactly this size. */
export const SALE_SIZE = 8 + 32 + 32 + 32 + 32 + 8 + 8 + 8 + 8 + 8 + 8 + 16 + 16 + 8 + 8 + 8 + 8
  + 4 + 8 + 8 + 8 + 8 + 8 + 8 + 1 + 1 + 1 + 1 + 1 + (4 + MAX_NAME) + (4 + MAX_SYMBOL)
  + (4 + MAX_URI) + 1 + 32 + 32 + 8 + 8 + 1
  // `sol_expected` + `sol_in`. ⛔ One number in two places — `Sale::SIZE` in lib.rs is the other.
  + 8 + 8

const errText = (e) => `${e?.message ?? e} ${(e?.logs ?? e?.transactionLogs ?? []).join(' ')}`

/**
 * Every token transfer INTO `depositAccount`, oldest first, with who sent it and whether FOMO
 * co-signed the transaction.
 *
 * `ixIndex` is the top-level instruction index, or 128 + the position among inner instructions —
 * stable for a given transaction, which is all the receipt needs.
 */
export async function readTransfers(conn, depositAccount, { fomoCosigner, quoteMint = USDC_MINT, commitment = 'confirmed' }) {
  const dest = depositAccount.toBase58()
  const sigs = []
  for (let before; ;) {
    const page = await conn.getSignaturesForAddress(depositAccount, { before, limit: 1000 }, commitment)
    sigs.push(...page)
    if (page.length < 1000) break
    before = page.at(-1).signature
  }
  const out = []
  // getSignaturesForAddress is newest first; credits must be booked in chain order.
  for (const s of sigs.reverse()) {
    if (s.err) continue
    // A transaction's contents never change once it is at `commitment`, so each is parsed once per
    // process. Without this every pass re-downloaded every transfer a sale had ever received.
    const cacheKey = `${dest}:${s.signature}:${fomoCosigner.toBase58()}`
    if (parsedCache.has(cacheKey)) { out.push(...parsedCache.get(cacheKey)); continue }
    const found = []
    const tx = await conn.getParsedTransaction(s.signature, { maxSupportedTransactionVersion: 0, commitment })
    // ⛔ Never skip a transaction the RPC could not return yet: later credits would move past it and
    // it would then be refused as out of order. Stop, and read the whole list again next pass.
    if (!tx || tx.blockTime == null) throw new Error(`transaction ${s.signature.slice(0, 8)}… not readable yet`)
    if (tx.meta?.err) { parsedCache.set(cacheKey, found); continue }
    const keys = tx.transaction.message.accountKeys.map((k) => ({ pubkey: k.pubkey.toBase58(), signer: k.signer }))
    const fomo = keys.some((k) => k.signer && k.pubkey === fomoCosigner.toBase58())
    const balances = [...(tx.meta.preTokenBalances ?? []), ...(tx.meta.postTokenBalances ?? [])]
    const byAccount = (addr) => balances.find((b) => keys[b.accountIndex]?.pubkey === addr)

    const candidates = tx.transaction.message.instructions.map((ix, i) => [ix, i])
    let inner = 0
    for (const group of tx.meta.innerInstructions ?? []) for (const ix of group.instructions) candidates.push([ix, 128 + inner++])

    for (const [ix, ixIndex] of candidates) {
      // A receipt seed holds one byte. An index past 255 cannot be decided on chain at all, so it is
      // left alone rather than wrapping onto another transfer's receipt.
      if (ixIndex > 255) continue
      const t = ix.parsed?.type
      if (!['transfer', 'transferChecked'].includes(t) || !['spl-token', 'spl-token-2022'].includes(ix.program)) continue
      const info = ix.parsed.info
      if (info.destination !== dest) continue
      const mint = info.mint ?? byAccount(dest)?.mint
      if (mint !== quoteMint.toBase58()) continue
      const amount = BigInt(info.tokenAmount?.amount ?? info.amount)
      // The owner of the SOURCE account, not the signing authority: a delegate may sign, and
      // money goes back to whoever it belonged to.
      const owner = byAccount(info.source)?.owner ?? info.authority ?? info.multisigAuthority
      found.push({
        sig: s.signature, sigBytes: Buffer.from(bs58.decode(s.signature)), ixIndex,
        slot: tx.slot, blockTime: tx.blockTime, amount,
        source: new PublicKey(info.source), owner: new PublicKey(owner), fomo,
      })
    }
    parsedCache.set(cacheKey, found)
    out.push(...found)
  }
  return out
}
const parsedCache = new Map()

const send = (conn, ixs, signers) =>
  sendAndConfirmTransaction(conn, new Transaction().add(...ixs), signers, { commitment: 'confirmed' })

/**
 * One pass over one sale: credit or return every transfer not yet decided, then close credits
 * once the window is safely behind us.
 *
 * `settleSeconds` is how long after `window_end` to wait before closing — long enough that every
 * transaction made inside the window has been seen at `commitment`.
 */
export async function attestSale(conn, attester, sale, { fomoCosigner, settleSeconds = 60, returnMinimum = 1_000_000n, commitment = 'confirmed', log = () => {} }) {
  // A listing can name a sale this chain does not hold (a stale index, a wrong cluster). Skip it
  // quietly rather than failing the pass for every sale after it.
  const info = await conn.getAccountInfo(sale, 'confirmed')
  if (!info) return { credited: [], returned: [], missing: true }
  let s = readSale(info, sale)
  if (!s) return { credited: [], returned: [], notGenuine: true }
  const vault = vaultAddress(sale)
  // ⛔ A credit is priced on the SOL curve at the swap pool's spot, so every credit carries the
  // pool's two vaults — read off the pool account itself rather than trusted from a constant, the
  // same check the program makes.
  const pool = poolVaults((await conn.getAccountInfo(SWAP_POOL, 'confirmed'))?.data)
  const transfers = await readTransfers(conn, s.depositAccount, { fomoCosigner, quoteMint: s.quoteMint, commitment })
  const done = { credited: [], returned: [] }

  // Non-FOMO sends per sender, counted in chain order over ALL transfers (decided or not), so the
  // cap gives the same answer on every pass.
  const foreignSeen = new Map()
  const foreignRank = new Map()
  for (const t of transfers) {
    if (t.fomo) continue
    const k = t.owner.toBase58()
    foreignSeen.set(k, (foreignSeen.get(k) ?? 0) + 1)
    foreignRank.set(`${t.sig}:${t.ixIndex}`, foreignSeen.get(k))
  }

  for (const t of transfers) {
    const receipt = receiptAddress(sale, t.sigBytes, t.ixIndex)
    if (await conn.getAccountInfo(receipt, 'confirmed')) continue
    s = decodeSale((await conn.getAccountInfo(sale, 'confirmed')).data)

    let why = !t.fomo ? 'not sent from FOMO'
      : s.status !== 0 ? 'the sale is no longer open'
      : s.creditsClosed ? 'credits are closed'
      : BigInt(t.blockTime) >= s.windowEnd ? 'sent after the window closed'
      : null

    if (!why) {
      try {
        await send(conn, [creditIx(attester.publicKey, sale, s.depositAccount, {
          sig: t.sigBytes, ixIndex: t.ixIndex, slot: t.slot, blockTime: t.blockTime, depositor: t.owner, amount: t.amount,
        }, pool)], [attester])
        done.credited.push(t)
        log(`credited ${t.amount} from ${t.owner.toBase58()} (${t.sig.slice(0, 8)}…)`)
        continue
      } catch (e) {
        const name = DOES_NOT_FIT.find((n) => errText(e).includes(n))
        // Credits are ORDER-sensitive, so an unexpected failure stops this sale's pass: deciding a
        // later transfer first would price it ahead of this one.
        if (!name) throw e
        why = name
      }
    }

    // ⛔ Every return costs the attester a receipt's rent (~0.0009 SOL) and a fee, while a send
    // costs the sender a fraction of that. So: dust is never returned, a sender outside FOMO gets
    // at most MAX_FOREIGN_RETURNS_PER_SENDER returns, and the attester never pays to create the
    // sender's token account. Anything past those limits stays where it is.
    if (t.amount < returnMinimum) { done.ignored = (done.ignored ?? 0) + 1; continue }
    if (!t.fomo && foreignRank.get(`${t.sig}:${t.ixIndex}`) > MAX_FOREIGN_RETURNS_PER_SENDER) {
      done.ignored = (done.ignored ?? 0) + 1
      continue
    }

    // Back to the account it came from if that still exists; else the owner's own associated
    // account if THAT exists; else it waits (never create one on the attester's SOL).
    const ownerAta = getAssociatedTokenAddressSync(s.quoteMint, t.owner, true, TOKEN_PROGRAM_ID)
    let to = null
    for (const candidate of [t.source, ownerAta]) {
      const acct = await conn.getParsedAccountInfo(candidate, 'confirmed').catch(() => null)
      const parsed = acct?.value?.data?.parsed?.info
      if (parsed && parsed.mint === s.quoteMint.toBase58() && parsed.state !== 'frozen') { to = candidate; break }
    }
    // `waiting`, not `ignored`: this one is retried once the owner opens an account, so a settled
    // sale carrying it must not go quiet.
    if (!to) { log(`cannot return ${t.amount} to ${t.owner.toBase58()}: no open USDC account`); done.waiting = (done.waiting ?? 0) + 1; continue }
    try {
      await send(conn, [
        returnTransferIx(attester.publicKey, sale, vault, s.depositAccount, to, { sig: t.sigBytes, ixIndex: t.ixIndex, amount: t.amount }, s.quoteMint),
      ], [attester])
      done.returned.push({ ...t, why })
      log(`returned ${t.amount} to ${t.owner.toBase58()}: ${why}`)
    } catch (e) {
      // Returns are not order-sensitive: one that fails must not block the rest.
      log(`return of ${t.sig.slice(0, 8)}… failed, will retry: ${errText(e).slice(0, 160)}`)
    }
  }

  s = decodeSale((await conn.getAccountInfo(sale, 'confirmed')).data)
  const now = await chainTime(conn)
  if (s.status === 0 && !s.creditsClosed && now >= Number(s.windowEnd) + settleSeconds) {
    // Read the transfer list AGAIN, now that the settle time has passed, and close only if every
    // transfer made inside the window has a decision. The list read at the top of the pass may
    // predate transfers that finalized while this pass was crediting.
    const fresh = await readTransfers(conn, s.depositAccount, { fomoCosigner, quoteMint: s.quoteMint, commitment })
    /**
     * 🔴 The list itself can come back SHORT.
     *
     * `readTransfers` refuses to skip a transaction it cannot parse, but `getSignaturesForAddress`
     * can simply not mention one yet — and a short list makes the "everything is decided" check
     * below vacuously true. Closing credits on that would refuse a transfer that was made inside
     * the window: the buyer gets their money back instead of tokens. Nothing is lost, but it is
     * the wrong answer, and it is invisible.
     *
     * So the account's own BALANCE is the cross-check. Everything sitting in it is either credited
     * (`gross`) or something this pass saw and chose to leave. Anything else is a transfer the
     * list did not mention, and credits stay open until it does.
     */
    const held = BigInt((await conn.getTokenAccountBalance(s.depositAccount, 'confirmed')).value.amount)
    const leftBehind = fresh
      .filter((t) => t.amount < returnMinimum || (!t.fomo && foreignRank.get(`${t.sig}:${t.ixIndex}`) > MAX_FOREIGN_RETURNS_PER_SENDER))
      .reduce((a, t) => a + t.amount, 0n)
    if (held > s.gross + leftBehind) {
      log(`credits stay open: the deposit account holds ${held} against ${s.gross} credited and ${leftBehind} left behind`)
      return { ...done, closePending: true }
    }
    for (const t of fresh) {
      if (BigInt(t.blockTime) >= s.windowEnd || t.amount < returnMinimum) continue
      if (!(await conn.getAccountInfo(receiptAddress(sale, t.sigBytes, t.ixIndex), 'confirmed'))) {
        if (!t.fomo && foreignRank.get(`${t.sig}:${t.ixIndex}`) > MAX_FOREIGN_RETURNS_PER_SENDER) continue
        return { ...done, closePending: true }
      }
    }
    await send(conn, [closeCreditsIx(attester.publicKey, sale)], [attester])
    done.closed = true
    log('credits closed')
  }
  return done
}

/**
 * The chain's clock.
 *
 * ⛔⛔ Asks the TIP, then walks back — because Solana skips slots and a skipped slot has no block
 * time, ever. The one-liner this replaces (`getBlockTime(await getSlot())`) threw
 * `Block not available for slot N` whenever the tip happened to be skipped, and that throw
 * aborted the whole attest or crank for that sale. At 15s a pass that was a shrug; once the
 * watcher had 97 sales and a pass took 18 minutes, every occurrence cost a sale ~18 minutes of
 * waiting with a buyer's money already in the vault.
 *
 * ⚠ Skipped slots come in ones and twos, not runs of eight, so this practically always returns on
 * the first or second try. It still throws rather than guessing if none of them answer: a wrong
 * clock decides whether a window is closed, and that must never be invented.
 */
export const chainTime = async (conn) => {
  const tip = await conn.getSlot('confirmed')
  let last = null
  for (let back = 0; back < 8; back++) {
    try {
      const t = await conn.getBlockTime(tip - back)
      if (t != null) return t
    } catch (e) { last = e }
  }
  throw new Error(`could not read the chain clock from slots ${tip - 7}..${tip}${last ? `: ${last.message}` : ''}`)
}

/**
 * Every position in a sale — WITHOUT `getProgramAccounts`, which public RPCs refuse.
 *
 * A position only ever comes from a credit, and a credit only ever comes from a transfer into the
 * deposit account, so the senders of those transfers are a complete list of candidate owners.
 * Derive each one's position address and read them all at once.
 */
export async function positionsOf(conn, sale, { fomoCosigner, depositAccount, quoteMint, expect = null }) {
  const transfers = await readTransfers(conn, depositAccount, { fomoCosigner, quoteMint })
  const owners = [...new Map(transfers.map((t) => [t.owner.toBase58(), t.owner])).values()]
  const out = []
  // ⛔ RPC_BATCH, not 100: above ten accounts this endpoint refuses the read outright, and every
  // delivery in the sale would have failed with it.
  for (let i = 0; i < owners.length; i += RPC_BATCH) {
    const chunk = owners.slice(i, i + RPC_BATCH)
    const infos = await conn.getMultipleAccountsInfo(chunk.map((o) => positionAddress(sale, o)), 'confirmed')
    infos.forEach((info, j) => { if (info) out.push({ address: positionAddress(sale, chunk[j]), ...decodePosition(info.data) }) })
  }
  /**
   * 🔴 UNREADABLE IS NOT EMPTY.
   *
   * The owner list is derived from the deposit account's transfer history, and
   * `getSignaturesForAddress` can return a short list — or nothing — for a moment after a burst.
   * Every position then goes missing at once, `crankSale` delivers to nobody, and it reports
   * success: `delivered: 0`, no error, no log line. It self-heals on the next pass, so it hides.
   *
   * The sale counts its own depositors, so there is a number to check against. A short read
   * raises instead of quietly delivering to a subset — which is the same failure with money in it.
   */
  if (expect !== null && out.length < expect) {
    throw new Error(`the deposit history named ${out.length} of ${expect} positions; refusing to deliver on a partial read`)
  }
  return out
}

/**
 * The permissionless half: launch or fail a settled sale, then deliver every position.
 * `lookupTable` is the shared launch table (an AddressLookupTableAccount).
 */
export async function crankSale(conn, cranker, sale, { lookupTable, fomoCosigner, log = () => {}, jupiter = {} }) {
  const info = await conn.getAccountInfo(sale, 'confirmed')
  if (!info) return { launched: false, failed: false, delivered: 0, missing: true }
  let s = readSale(info, sale)
  if (!s) return { launched: false, failed: false, delivered: 0, notGenuine: true }
  const vault = vaultAddress(sale)
  const now = await chainTime(conn)
  const settled = now >= Number(s.windowEnd) && (s.creditsClosed || now >= Number(s.windowEnd) + 15 * 60)
  const done = { launched: false, failed: false, swapped: false, delivered: 0 }

  if (s.status === 0 && settled) {
    // ⭐ `sold > 0` is deliberately NOT a condition: a window nobody bought into still launches,
    // and the program skips the buy. The minimum raise is the only floor, and it defaults to zero.
    if (s.gross >= s.minRaise && now < Number(s.launchDeadline)) {
      const v0 = async (instructions, extraTables = []) => {
        const msg = new TransactionMessage({
          payerKey: cranker.publicKey,
          recentBlockhash: (await conn.getLatestBlockhash()).blockhash,
          instructions,
        }).compileToV0Message([lookupTable, ...extraTables])
        const tx = new VersionedTransaction(msg)
        tx.sign([cranker])
        const sig = await conn.sendTransaction(tx)
        await conn.confirmTransaction(sig, 'confirmed')
        return sig
      }

      // ⭐ The raise is USDC and the curve is priced in SOL, so the money is swapped FIRST — in
      // its own transaction, because create + buy is already near the size limit and because the
      // swap must be settled before the launch can know what it has to spend.
      // ⛔ Deliberately not atomic with the launch: what protects the money is the program's own
      // min-out and balance check, not the two landing together. A swap that lands without a
      // launch leaves SOL in the vault and the next pass launches it.
      if (s.gross > 0n && s.solIn === 0n) {
        const pool = poolVaults((await conn.getAccountInfo(SWAP_POOL, 'confirmed'))?.data)
        log(`swapping ${s.gross} USDC to SOL`)
        const sig = await v0([
          ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
          swapToSolIx(cranker.publicKey, sale, vault, pool,
                      { ...SWAP_MARKET, depositAccount: s.depositAccount }, s.quoteMint),
        ])
        s = decodeSale((await conn.getAccountInfo(sale, 'confirmed')).data)
        log(`swapped: ${s.solIn} lamports (${sig.slice(0, 8)}…)`)
        done.swapped = true
      }

      // ⭐ A custom pair: the SOL goes on into the pair token, through Jupiter, then `launch_pair`.
      // Attester only — the program refuses anyone else, so `cranker` must BE the attester here
      // (it is in production: run.mjs cranks with the attester key unless CRANKER_KEY is set).
      const pair = s.pair ? await readPair(conn, sale) : null
      if (s.pair && !pair) throw new Error('pair sale without a pair account')
      if (pair && s.solIn > 0n && pair.pairIn === 0n) {
        const { route, minOut, lookupTables } = await jupiterPairRoute(vault, pair, s.solIn, jupiter)
        // Jupiter's own tables. `jupiter.tables` replaces them only in the local suite, where a
        // table cloned from mainnet is unusable (its entries activate at a mainnet slot).
        const tables = jupiter.tables ? [...jupiter.tables] : []
        for (const t of jupiter.tables ? [] : lookupTables) {
          const v = (await conn.getAddressLookupTable(new PublicKey(t))).value
          if (v) tables.push(v)
        }
        log(`swapping ${s.solIn} lamports to ${pair.mint.toBase58()} (floor ${minOut})`)
        const sig = await v0([
          ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 }),
          swapToPairIx(cranker.publicKey, sale, vault, s.depositAccount, pair, route, minOut),
        ], tables)
        pair.pairIn = (await readPair(conn, sale)).pairIn
        log(`swapped to ${pair.pairIn} pair base units (${sig.slice(0, 8)}…)`)
      }

      // The coin's address is picked HERE, from a random 64-bit nonce, so nobody can know it early
      // enough to block the launch (see `launch`).
      const { nonce, mint: minted } = await grind(sale.toBase58())
      log(`launching as ${minted}${pair ? ` paired with ${pair.mint.toBase58()}` : ''}`)
      const sig = await v0([
        ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }),
        // ⛔ `s.holderRewards` is not decoration here: it moves the curve's creator to a
        // `holder-rewards` PDA, so `creator_vault` derives from a different account. Passing the
        // default would build a launch pump.fun rejects.
        pair
          ? launchPairIx(cranker.publicKey, sale, vault, nonce, s.creatorFeeRecipient, s.holderRewards, pair)
          : launchIx(cranker.publicKey, sale, vault, nonce, s.creatorFeeRecipient, s.holderRewards),
      ])
      done.launched = true
      log(`launched (${sig.slice(0, 8)}…)`)
    } else {
      await send(conn, [failSaleIx(sale)], [cranker])
      done.failed = true
      log('failed: minimum not met or never launched')
    }
    s = decodeSale((await conn.getAccountInfo(sale, 'confirmed')).data)
  }

  if (s.status === 1 || s.status === 2) {
    /**
     * 🔴 A failed sale refunds in whatever the raise had BECOME when it failed. Usually the USDC
     * is still in the deposit account. But a sale can be swapped and then never launch before its
     * deadline, and its USDC is SOL in the vault by then — or, for a pair sale, the pair token in
     * the vault's token account. `refund_push` on such a sale transfers from an empty account and
     * fails for every buyer forever; the program now refuses it (`SwappedRefund`) and pays pro
     * rata through `refund_sol` / `refund_pair` instead.
     */
    const failedPair = s.status === 2 && s.pair ? await readPair(conn, sale) : null
    const refundIx = (owner) =>
      failedPair && failedPair.pairIn > 0n ? refundPairIx(cranker.publicKey, sale, vault, failedPair, owner)
      : s.solIn > 0n ? refundSolIx(sale, vault, owner, s.pair ? pairAddress(sale) : null)
      : refundPushIx(sale, vault, s.depositAccount, owner, s.quoteMint)
    // `complete` is true only once every position this pass could see is claimed. A settled sale
    // may go quiet on that and on nothing less — a delivery that failed leaves `unclaimed` > 0.
    done.unclaimed = 0
    for (const p of await positionsOf(conn, sale, {
      fomoCosigner, depositAccount: s.depositAccount, quoteMint: s.quoteMint, expect: s.depositors,
    })) {
      if (p.claimed) continue
      done.unclaimed++
      const ix = s.status === 1
        ? distributeIx(cranker.publicKey, sale, vault, s.mint, p.owner)
        : refundIx(p.owner)
      // Only a USDC refund needs the owner's USDC account made first; the SOL and pair refunds
      // create nothing (SOL) or create it inside the instruction (pair).
      const pre = s.status === 2 && s.solIn === 0n
        ? [createAssociatedTokenAccountIdempotentInstruction(cranker.publicKey, getAssociatedTokenAddressSync(s.quoteMint, p.owner, true), p.owner, s.quoteMint)]
        : []
      try {
        await send(conn, [...pre, ix], [cranker])
        done.delivered++
        done.unclaimed--
      } catch (e) {
        // One undeliverable position (a frozen account, say) must not block everyone after it.
        log(`delivery to ${p.owner.toBase58()} failed, will retry: ${errText(e).slice(0, 160)}`)
      }
    }
    if (done.delivered) log(`${s.status === 1 ? 'delivered tokens' : 'refunded'} to ${done.delivered} wallet(s)`)
    done.complete = done.unclaimed === 0
  }
  return done
}

/**
 * The sale at an address, or null when there is no genuine sale there.
 *
 * ⛔ Not every address the listing names holds a sale: the platform's own token rides along in
 * `/api/sales` keyed by its MINT, and a mint decoded as a sale throws from deep inside
 * `decodeSale` ("offset is out of range"). Both halves used to fail on it every pass. A
 * non-sale is nothing to do, not an error.
 */
export const readSale = (info, address = null) => {
  if (!info?.data) return null
  let s
  try { s = decodeSale(info.data) } catch { return null }
  // Owned by the program, carrying the Sale discriminator, and — when the caller says which
  // address it read — sitting at the address its own bytes derive. See `isProgramSale`.
  if (!info.owner?.equals?.(PROGRAM_ID)) return null
  if (!Buffer.from(info.data.subarray(0, 8)).equals(SALE_DISC)) return null
  if (address && !saleAddress(s.authority, s.saleId).equals(new PublicKey(address))) return null
  return isGenuineSale(s) ? s : null
}
