/** Connection wiring and read helpers. */
import { Connection, PublicKey } from '@solana/web3.js'
import { decodeSale, decodePosition, positionAddress, vaultAddress, PROGRAM_ID, isGenuineSale, isProgramSale, SWAP_POOL, poolVaults, USDC_MINT } from './program.mjs'
import { VS0, VT0 } from './curve.mjs'

/**
 * ⛔⛔ The browser's endpoint, and it is NOT `api.mainnet-beta.solana.com`.
 *
 * That host answers **403 Access forbidden to every method called from a browser** — not rate
 * limiting, not CORS on one route: a flat refusal of browser origins. Measured in Chrome against
 * the live build on 28 Aug 2026, `getHealth` and `getSlot` included.
 *
 * It was the default here for months and nothing caught it, because every check that mattered ran
 * in **node**, where that host answers perfectly well. `fees.mjs` had already quietly moved to
 * publicnode for its own reasons. The result was a deployed site on which no chain read could
 * succeed for any visitor — sale pages, portfolio, deposit previews, all of it — while every
 * suite passed.
 *
 * ⚠ An RPC endpoint for the browser has to be verified FROM a browser. Node is not a proxy for it.
 */
const ENDPOINTS = {
  'solana:mainnet': 'https://solana-rpc.publicnode.com',
  'solana:devnet': 'https://api.devnet.solana.com',
  'solana:localnet': 'http://127.0.0.1:8999',
}

export function endpointFor(chain) {
  return import.meta.env.VITE_RPC_URL || ENDPOINTS[chain] || ENDPOINTS['solana:localnet']
}
export const connectionFor = (chain) => new Connection(endpointFor(chain), 'confirmed')

/**
 * Seconds to SUBTRACT from the host clock to get the chain's.
 *
 * Every deadline in a sale — `window_end`, `launch_deadline` — is written from Solana's
 * `Clock::unix_timestamp`, which advances with slots and drifts from wall time under load. The
 * program will only ever agree with its own clock, so a countdown run off `Date.now()` is
 * comparing two different clocks: on the local validator it sat 4,605 seconds ahead and reported
 * an open window as "closed".
 *
 * Read once per sale load rather than per tick — the drift moves slowly, and the countdown should
 * tick smoothly off the local clock with this as its anchor.
 */
export async function clockSkew(conn) {
  // `getBlockTime` returns null for a slot that has not been timestamped yet, and the newest
  // confirmed slot frequently is one. Walking back a little always lands on a slot that has been.
  for (const commitment of ['finalized', 'confirmed']) {
    try {
      const slot = await conn.getSlot(commitment)
      for (const back of [0, 10, 50, 200]) {
        if (slot - back < 0) break
        const chain = await conn.getBlockTime(slot - back)
        if (chain !== null) return Math.floor(Date.now() / 1000) - chain
      }
    } catch { /* try the next commitment */ }
  }
  return 0   // an unreadable clock is not a reason to render nothing
}

/**
 * Is the program actually deployed on the cluster this page is reading?
 *
 * ⛔ This is not a paranoid check. The build carries ONE program id and is pointed at a cluster by
 * `VITE_CHAIN`, and those two can disagree — a mainnet build against an id that only exists on a
 * local validator looks completely normal until a transaction is sent, at which point it fails.
 * Every action on this site targets that id, so a page that cannot see it cannot do anything.
 *
 * The failure it prevents is specific and was live on pump.family: the listing's empty state
 * invited a visitor to open a sale, and the create flow would grind a vanity mint, upload
 * metadata and prompt a wallet signature for a transaction that could never land. ⭐ The project's
 * own rule, for the fourth time: **an action the UI offers must be one the chain will accept.**
 *
 * Rendered as an EXPLAINED state rather than a silent failure, exactly as a missing indexer is —
 * the two are the same class of problem and deserve the same treatment.
 *
 * Cached per connection endpoint: it is one account read, it cannot change while the page is
 * open, and every surface asks the same question.
 */
const deployedCache = new Map()
export async function programDeployed(conn) {
  const key = conn.rpcEndpoint
  if (deployedCache.has(key)) return deployedCache.get(key)
  let answer
  try {
    const info = await conn.getAccountInfo(PROGRAM_ID)
    // `executable` matters, not mere existence: an id that holds a non-program account is just as
    // unusable, and says something different about what went wrong.
    answer = { ok: !!info && info.executable, present: !!info, endpoint: key }
  } catch (e) {
    // ⛔ An unreachable RPC is NOT an absent program — but it is not "fine" either, and the first
    // version of this returned `ok: true` for it. That silence is exactly what hid a mainnet
    // endpoint answering 403 to every browser request: the check threw, was swallowed as
    // "unknown, assume deployed", and the page rendered as though everything worked.
    // `unreachable` is now its own reported state.
    answer = { ok: false, unreachable: true, error: e.message ?? String(e), endpoint: key }
  }
  deployedCache.set(key, answer)
  return answer
}


/**
 * The shape `Sale.jsx` expects, built from an indexer row rather than an account.
 *
 * ⚠ Every field the page reads must be present and of the right TYPE — the page does bigint
 * arithmetic on these. A missing one is `0n`, never `undefined`, or a render throws on a page
 * that is already in its degraded path.
 */
function fromIndexedRow(saleKey, row) {
  const sk = new PublicKey(saleKey)
  const big = (v) => BigInt(Math.trunc(Number(v ?? 0)))
  return {
    address: sk,
    vault: vaultAddress(sk),
    mint: row.mint ? new PublicKey(row.mint) : PublicKey.default,
    position: null,
    reserves: null,
    sweepable: null,
    skew: 0,
    sale: {
      name: row.name ?? '', symbol: row.symbol ?? '', uri: row.uri ?? '',
      status: row.status ?? 0, statusLabel: '',
      windowEnd: big(row.windowEnd), launchDeadline: big(row.launchDeadline),
      hardCap: big(row.hardCap), minRaise: big(row.minRaise), perWalletCap: big(row.perWalletCap),
      gross: big(row.gross), sold: big(row.sold), depositors: Number(row.depositors ?? 0),
      quoteLabel: row.quoteLabel ?? 'usdc',
      quoteMint: row.quoteMint ? new PublicKey(row.quoteMint) : USDC_MINT,
      authority: row.authority ? new PublicKey(row.authority) : PublicKey.default,
      creatorFeeRecipient: row.creatorFeeRecipient ? new PublicKey(row.creatorFeeRecipient) : PublicKey.default,
      tokensReceived: 0n, claimedTotal: 0n,
      // ⛔ Read from the row, NOT zeroed. These are the raise in lamports, and hardcoding them
      // made this degraded path state a falsehood rather than admit a gap: a real sale holding
      // real money rendered "0.000 SOL" raised whenever the chain read blipped. `gross` cannot
      // stand in for them — it is USDC, and converting it at a spot rate is a later, different
      // number. Sales indexed before the column existed read 0, which the page treats as unknown
      // and estimates from `gross` rather than printing as fact.
      solIn: big(row.solIn), solExpected: big(row.solExpected),
      // ⚠ The curve OPENS at these. Zeroes here are not "unknown", they are a curve with no
      // reserves, and anything that prices against one either divides by zero or throws.
      virtualSol: VS0, virtualToken: VT0, curveIn: 0n, feeHeld: 0n, reserve: 0n,
      depositAccount: PublicKey.default, holderRewards: row.holderRewards ?? false,
      mintNonce: 0n, vaultBump: 0, mintBump: 0, bump: 0, saleId: 0n,
      protocolFeeBps: 0, creatorFeeBps: 0, cashback: false, quote: 1,
    },
  }
}

/**
 * Reads a sale plus the connected wallet's position in it, tolerating either being absent.
 *
 * ⛔⛔ `indexed` is the indexer's row for this address, when it has one, and it exists for a
 * reason that is not cosmetic: **unreadable is not empty.** An RPC that answered `null` for an
 * account that exists — under load, lagging, rate-limited — made this page say "No sale at that
 * address on this cluster" about a live sale holding real buyers' money. The indexer only ever
 * holds addresses it discovered from the program's own logs, so if it knows this address, the
 * sale is real and the chain read is what failed.
 *
 * ⛔ A row served this way is marked `stale` and EVERY action is withheld: no buy, no launch, no
 * refund, no position. Those need chain truth, and a cached row is not it. What it can honestly
 * do is show the coin instead of denying it exists.
 */
export async function loadSale(conn, saleKey, owner, indexed = null) {
  const acc = await conn.getAccountInfo(new PublicKey(saleKey))
  if (!acc) {
    if (indexed) return { ...fromIndexedRow(saleKey, indexed), stale: true }
    return { error: 'No sale at that address on this cluster.' }
  }
  let sale
  try { sale = decodeSale(acc.data) } catch (e) { return { error: `Could not decode sale: ${e.message}` } }
  /**
   * 🔴 Sale-SHAPED bytes are not a sale. Before this, any account whose data decoded — written by
   * anyone, at any address — was shown as one, deposit address and all: a link to an attacker's
   * account would have displayed THEIR deposit account under our name (outside review, 22 Sep
   * 2026). The program must own it, it must carry the Sale discriminator, and its address must be
   * the one its own authority and id derive.
   */
  if (!isProgramSale(saleKey, acc, sale)) {
    return { error: 'This account was not written by the Pump Family program. Do not send anything to it.' }
  }
  if (!isGenuineSale(sale)) {
    return { error: 'This is not a genuine Pump Family sale: it is not priced in real USDC. Do not send anything to it.' }
  }
  const sk = new PublicKey(saleKey)
  // The mint is read from the sale rather than re-derived. Its seeds now include a ground nonce,
  // so deriving it needs that nonce anyway, and the account already records the authoritative value.
  /**
   * ⛔ The swap pool's reserves come back with the sale, because without them the page cannot
   * price a buy at all. Buyers pay USDC and the coin trades on pump.fun's SOL curve, so every
   * quote runs USDC → lamports at this pool's spot, then lamports → tokens on the curve. The same
   * two steps, in the same order, that `credit` takes on chain.
   *
   * `null` when the pool cannot be read — the page then says it cannot quote rather than quoting
   * at a rate it made up.
   */
  let reserves = null
  try {
    const poolAcc = await conn.getAccountInfo(SWAP_POOL)
    const { solVault, usdcVault } = poolVaults(poolAcc.data)
    const [sv, uv] = await conn.getMultipleAccountsInfo([solVault, usdcVault])
    const amount = (a) => a.data.readBigUInt64LE(64)
    reserves = { sol: amount(sv), usdc: amount(uv) }
  } catch { reserves = null }

  const vault = vaultAddress(sk)
  /**
   * What the vault actually holds, so the creator's "reclaim your reserve" button can be offered
   * only when there IS something to reclaim.
   *
   * ⛔ `null` means the balance could not be read — which the page must treat as "do not offer",
   * never as zero and never as plenty. A button that always errors is worse than no button.
   */
  let sweepable = null
  try {
    // ⛔ The floor is READ, not assumed. It was hard-coded here as 890,880 — the number every
    // Solana doc quotes for a 0-byte account — and this cluster's is 650,240. Rent parameters are
    // chain state, and a constant copied from documentation is a guess with a citation.
    const [bal, floor] = await Promise.all([
      conn.getBalance(vault),
      conn.getMinimumBalanceForRentExemption(0),
    ])
    sweepable = Math.max(0, bal - floor)
  } catch { sweepable = null }

  const out = {
    sale, address: sk, vault, mint: sale.mint, position: null,
    reserves, sweepable,
    skew: await clockSkew(conn),
  }
  if (owner) {
    const p = await conn.getAccountInfo(positionAddress(sk, new PublicKey(owner)))
    if (p) { try { out.position = decodePosition(p.data) } catch { /* not a position */ } }
  }
  return out
}
