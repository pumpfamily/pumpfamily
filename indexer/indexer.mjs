/**
 * Sale discovery for Pump Family.
 *
 * ## Why this exists
 *
 * The obvious way to list open sales is `getProgramAccounts` with a memcmp filter on the sale
 * discriminator. That call is **403-blocked on the operator's Helius plan**, and it is the first
 * method every provider disables under load, so building the front end on it would put the entire
 * listing at the mercy of a billing tier.
 *
 * So discovery runs on two calls that no provider blocks:
 *
 *  - `getSignaturesForAddress(PROGRAM_ID)` walks history backwards to find sales opened before
 *    this service existed, and to close any gap after a restart.
 *  - `logsSubscribe` catches sales opened while it is running.
 *
 * Both yield only an ADDRESS. Every number then comes from `getAccountInfo` on the sale itself.
 * That split is the point: a replayed event stream drifts from the chain the moment a deposit is
 * missed, whereas an account read cannot be stale in a way that matters — it either reflects the
 * chain or it failed.
 *
 * ## ⚠ The limit of history-walking
 *
 * `getSignaturesForAddress` can only return what the RPC still holds. **A provider's history
 * window is finite**, so a sale opened while this service was down for longer than that window is
 * never discovered by backfill — the subscription missed it and history no longer mentions it.
 *
 * Three things keep that from mattering, in order of importance:
 *
 *  1. **`sales.db` is never rebuilt from scratch in normal operation.** Once an address is known
 *     it stays known, and its state comes from an account read that has no history window at all.
 *     The store persisting across restarts is the actual defence; treat deleting it as a last
 *     resort, not routine maintenance.
 *  2. The backfill timer is 5 minutes by default — inside any provider's window by a wide margin.
 *  3. Discovery is not the only path to a sale. Sales are shared by link, and `/api/sales/<addr>`
 *     and the site both read an address directly.
 *
 * ⛔ Local validators are much worse than any provider: `solana-test-validator` prunes to roughly
 * the last 90 slots (`getFirstAvailableBlock` was 1557 at slot 1645), so a backfill there sees
 * only the last minute or so of history. `indexer.test.mjs` proves discovery of sales opened
 * before the service started and gap-closing across a restart; it cannot prove a walk from
 * genesis, because locally there is no genesis left to walk to.
 */
import { Connection, PublicKey } from '@solana/web3.js'
import { pacedOptions, rpsFromEnv } from '../rpc-pace.mjs'
import { decodeSale, isProgramSale, PROGRAM_ID, RPC_BATCH, SWAP_POOL, poolVaults, QUOTE_CONTROL, decodeQuoteControl, USDC_MINT, pairAddress, decodePair } from '../program.mjs'
import { solUsdFromReserves, SUPPLY } from '../curve.mjs'
import {
  bondingCurveAddress, poolAddress, decodeBondingCurve, decodePool, tokenAccountAmount,
  marketCapFromCurve, marketCapFromPool, POOL_INDEXES,
} from '../market.mjs'
import { salesOpened, salesSettled, depositsIn } from './events.mjs'
import { openStore } from './store.mjs'

export /** Mints per Jupiter token-search call. A web API's limit, not the RPC's — see `refreshPairs`. */
const JUPITER_TOKENS_BATCH = 100

const DEFAULTS = {
  rpc: process.env.RPC_URL || 'http://127.0.0.1:8999',
  db: process.env.INDEXER_DB || './sales.db',
  /** How often every known sale is re-read. One batched call per `batch` sales. */
  refreshMs: Number(process.env.REFRESH_MS || 20_000),
  /** How often history is re-walked, as a safety net under the websocket. */
  backfillMs: Number(process.env.BACKFILL_MS || 300_000),
  // The custom-pair list changes when pump.fun adds a token; prices matter only for display.
  pairsMs: Number(process.env.PAIRS_MS || 600_000),
  jupiterTokens: process.env.JUPITER_TOKENS_URL || 'https://lite-api.jup.ag/tokens/v2/search',
  /**
   * How many accounts go in one `getMultipleAccounts`.
   *
   * 🔴 **Not 100, the protocol limit.** publicnode — the endpoint this service runs on — answers
   * `403 Request blocked` to a batch of 15 while answering 10 fine (measured 18 Sep 2026). At 100
   * every refresh threw the moment there were more than ten sales, and the listing would have
   * frozen at whatever it last read, with the error visible only in `/api/health`. It was never
   * seen because the launchpad has never held ten sales at once.
   */
  batch: Number(process.env.RPC_BATCH || RPC_BATCH),
  /** Requests per second this process keeps under. 0 = unpaced (the local suite). */
  rps: rpsFromEnv(4),
}

const CURSOR = 'last_signature'

/**
 * The newest transaction version this service will accept.
 *
 * ⚠ **Not 0.** `getTransaction` THROWS rather than returning null when it meets a transaction
 * newer than what the caller says it supports, and mainnet now carries **version 1** transactions
 * — met while reading pump.fun's AMM on 18 Sep 2026:
 *   `Transaction version (1) is not supported by the requesting client.`
 * Our own transactions are v0, but the walk reads every signature that touches the program,
 * including other people's.
 */
const MAX_TX_VERSION = Number(process.env.MAX_TX_VERSION ?? 1)

/** What a SOL-denominated coin's pool is quoted in: pump.fun migrates into a WSOL pair. */
const WSOL = 'So11111111111111111111111111111111111111112'

/* ------------------------------------------------- token metadata over IPFS

⛔⛔ **A gateway's refusal is not evidence about a CID.** Measured from this machine on
21 Sep 2026, fetching the metadata URIs of the eight newest pump.fun coins:

    pump.mypinata.cloud   200
    ipfs.io               429  ×7

Seven perfectly good documents, unreadable through the host their own URI names. So a URI that
looks like an IPFS gateway link is retried through OTHER gateways for the same CID before the
document is called unreachable, and a refusal from one host is never recorded as a dead link.
*/

/** How many times a metadata URI is tried before it is finally called dead. */
export const METADATA_ATTEMPTS = 6

/** A definite "not there", as distinct from "could not reach it". */
export const NOT_FOUND = Symbol('metadata not found')

/**
 * Gateways to try for a CID, in order. The URI's own host goes first and is not repeated.
 *
 * ⚠ Measured, not chosen. Fetching the image CIDs of six real pump.fun coins, 21 Sep 2026:
 * both Pinata hosts returned **200 with byte-identical bodies** every time, `ipfs.filebase.io`
 * served most, `ipfs.io` answered **429 on all six**, and `cloudflare-ipfs.com` did not resolve
 * at all. ⛔ `ipfs.io` stays on the list, last, because a gateway refusing us is not evidence the
 * CID is bad — but nothing should be SENT to a visitor pointing there if a CID gives a choice.
 */
const GATEWAYS = [
  'https://pump.mypinata.cloud/ipfs/',
  'https://gateway.pinata.cloud/ipfs/',
  'https://ipfs.filebase.io/ipfs/',
  'https://ipfs.io/ipfs/',
]

/** The CID (and any path after it) inside an `ipfs://` or `.../ipfs/<cid>` URL, else null. */
export function cidOf(u) {
  if (typeof u !== 'string') return null
  const direct = /^ipfs:\/\/(?:ipfs\/)?(.+)$/i.exec(u.trim())
  if (direct) return direct[1]
  const viaPath = /\/ipfs\/([^?#]+)/i.exec(u)
  return viaPath ? viaPath[1] : null
}

/**
 * The URL a VISITOR should be given for an image.
 *
 * Any reference carrying a CID — `ipfs://…` or a link through someone else's gateway — is
 * re-pointed at the gateway that actually serves, because the host inside the document is not a
 * promise about anything. A plain https URL with no CID is left exactly as it is.
 *
 * ⛔ This is the one string on the row that a browser loads directly, so it is also the one that
 * fails in a way nothing here can see: the row reads `ok`, the card renders, and the picture is
 * a broken square. Sending it to a host that answered 429 six times out of six is not neutral.
 */
export function gatewayFor(u) {
  const cid = cidOf(u)
  return cid ? GATEWAYS[0] + cid : u
}

/** Every URL worth trying for one metadata URI: itself, then the same CID on other gateways. */
export function candidatesFor(uri) {
  const out = [uri]
  const cid = cidOf(uri)
  if (!cid) return out
  let host = ''
  try { host = new URL(uri).origin + '/ipfs/' } catch { /* not a URL; the CID still is */ }
  for (const g of GATEWAYS) if (g !== host) out.push(g + cid)
  return out
}

/**
 * Fetches a metadata document, walking gateways.
 *
 * Returns the body, `NOT_FOUND` when a host answered a definite 404/410, or `null` when nothing
 * could be reached — which the caller must treat as "try again later", never as a dead link.
 *
 * ⚠ A 404 only settles it when NO candidate could be reached any other way: one gateway not
 * holding a CID says nothing about the CID.
 */
export async function fetchMetadataDocument(uri, fetchImpl = fetch, { lookup = dnsLookup } = {}) {
  let sawNotFound = false
  for (const url of candidatesFor(uri)) {
    try {
      const res = await fetchPublic(url, fetchImpl, lookup)
      if (res.ok) return await readBounded(res, MAX_METADATA_BYTES)
      if (res.status === 404 || res.status === 410) { sawNotFound = true; continue }
      // 429 and 5xx are the host's problem, not the document's: try the next one.
    } catch { /* unreachable, private, or oversized host: try the next one */ }
  }
  return sawNotFound ? NOT_FOUND : null
}

/** The most of a metadata document this service will read. Anything past it is cut, not buffered. */
export const MAX_METADATA_BYTES = 64_000
const MAX_REDIRECTS = 3

/**
 * Is this an address a server on the public internet could legitimately answer from?
 *
 * 🔴 The metadata URI is written by whoever opened the sale, and this service fetched it from
 * INSIDE the box — so a creator could point it at `127.0.0.1:5250`, the box's own private
 * services, a cloud metadata endpoint, or redirect there from a public host (outside review,
 * 22 Sep 2026). Loopback, private, link-local, multicast, unspecified and the v4-mapped forms of
 * all of those are refused, and every redirect hop is checked again.
 */
export function isPublicAddress(ip) {
  const v4 = (a) => {
    const p = a.split('.').map(Number)
    if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false
    const [a0, a1] = p
    if (a0 === 0 || a0 === 10 || a0 === 127) return false                 // this-net, private, loopback
    if (a0 === 100 && a1 >= 64 && a1 <= 127) return false                  // carrier-grade NAT
    if (a0 === 169 && a1 === 254) return false                             // link-local, cloud metadata
    if (a0 === 172 && a1 >= 16 && a1 <= 31) return false                   // private
    if (a0 === 192 && a1 === 168) return false                             // private
    if (a0 === 192 && a1 === 0 && p[2] === 0) return false                 // IETF protocol assignments
    if (a0 === 198 && (a1 === 18 || a1 === 19)) return false               // benchmarking
    if (a0 >= 224) return false                                            // multicast, reserved, broadcast
    return true
  }
  const s = String(ip).toLowerCase()
  if (!s.includes(':')) return v4(s)
  // v6: the mapped/compatible forms carry a v4 address that must pass the v4 rules.
  const mapped = s.match(/^(?:::ffff:|::)(\d+\.\d+\.\d+\.\d+)$/)
  if (mapped) return v4(mapped[1])
  if (s === '::' || s === '::1') return false                               // unspecified, loopback
  if (/^f[cd]/.test(s)) return false                                       // unique local fc00::/7
  if (/^fe[89ab]/.test(s)) return false                                    // link-local fe80::/10
  if (/^ff/.test(s)) return false                                          // multicast
  if (s.startsWith('64:ff9b:')) return false                               // NAT64 (carries a v4)
  if (s.startsWith('2001:db8:')) return false                              // documentation
  return true
}

/** Every address a host resolves to, or [] when it does not resolve. */
async function dnsLookup(host) {
  const { lookup } = await import('node:dns/promises')
  try { return (await lookup(host, { all: true })).map((a) => a.address) } catch { return [] }
}

/**
 * Fetches a URL only if its host — and every host it redirects to — resolves ONLY to public
 * addresses. Redirects are followed by hand so each hop is checked; `fetchImpl` never follows
 * one itself.
 *
 * ⚠ The check is on the resolved addresses at the moment of the lookup; a host that answers
 * differently to the fetch's own lookup (DNS rebinding) is out of this function's reach. The box's
 * own services do not listen on anything a creator can name, which is the second wall.
 */
export async function fetchPublic(url, fetchImpl = fetch, lookup = dnsLookup) {
  let current = url
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const u = new URL(current)
    if (!['http:', 'https:'].includes(u.protocol)) throw new Error(`refusing ${u.protocol}`)
    const host = u.hostname.replace(/^\[|\]$/g, '')
    const addresses = /^[\d.]+$/.test(host) || host.includes(':') ? [host] : await lookup(host)
    if (!addresses.length || !addresses.every(isPublicAddress)) throw new Error(`refusing non-public host ${host}`)
    const res = await fetchImpl(current, { redirect: 'manual', signal: AbortSignal.timeout(8000) })
    const location = typeof res.headers?.get === 'function' ? res.headers.get('location') : null
    if (res.status >= 300 && res.status < 400 && location) {
      current = new URL(location, current).toString()
      continue
    }
    return res
  }
  throw new Error('too many redirects')
}

/**
 * Reads at most `max` bytes of a body and STOPS — the old `text().slice()` downloaded the whole
 * body first, so a creator could hand this service a gigabyte to hold before the cut.
 */
export async function readBounded(res, max) {
  if (!res.body?.getReader) return (await res.text()).slice(0, max)
  const reader = res.body.getReader()
  const chunks = []
  let size = 0
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      chunks.push(value)
      size += value.length
      if (size >= max) { await reader.cancel().catch(() => {}); break }
    }
  } finally { reader.releaseLock?.() }
  return Buffer.concat(chunks).subarray(0, max).toString('utf8').slice(0, max)
}


export class Indexer {
  constructor(opts = {}) {
    this.opts = { ...DEFAULTS, ...opts }
    // Paced: the key's burst limit is ~10/s and the watcher shares it (see rpc-pace.mjs).
    this.conn = new Connection(this.opts.rpc, pacedOptions(this.opts.rps, {
      commitment: 'confirmed',
      // Same endpoint over ws unless told otherwise; a provider that splits the two needs both.
      wsEndpoint: this.opts.ws || undefined,
    }))
    this.store = openStore(this.opts.db)
    this.subId = null
    this.timers = []
    /**
     * The CHAIN's clock, refreshed alongside the accounts.
     *
     * Every timestamp in a sale — `window_end`, `launch_deadline` — is written from Solana's
     * `Clock::unix_timestamp`, which is derived from slot progression and drifts from wall time
     * under load. Deciding whether a window is open by comparing those against `Date.now()` is
     * comparing two different clocks: it read open sales as closed on a loaded validator, and on
     * mainnet it would put the listing minutes out at exactly the wrong moment. The program will
     * only ever agree with its own clock, so that is the one the listing uses.
     */
    this.chainTime = null
    /**
     * USDC per SOL, from the Raydium pool the PROGRAM itself swaps through.
     *
     * ⭐ Every market cap the site shows is in dollars, which needs a SOL price, and it has to be
     * this one: the pages would otherwise quote a price a buyer is not charged. Measured against
     * pump.fun's own numbers it is the same price they display with, to 0.002%.
     *
     * ⛔ `null` until a read succeeds, and a failed read LEAVES THE LAST GOOD VALUE. A missing
     * price makes the site say SOL rather than invent a dollar figure.
     */
    this.solUsd = null
    /**
     * pump.fun's custom-pair tokens, mint → `{ mint, symbol, name, icon, decimals, tokenProgram,
     * usdPrice, liquidity }`. The launch form lists them, and a coin paired with one is priced
     * through its `usdPrice`. Refreshed every `pairsMs`; a failed refresh keeps the last list.
     */
    this.pairs = new Map()
    this.pairsAt = 0
    this.stats = { discovered: 0, refreshed: 0, metadata: 0, deposits: 0, backfills: 0, errors: 0, lastError: null, since: Date.now() }
  }

  /**
   * Walks the program's signature history newer than the stored cursor.
   *
   * `getSignaturesForAddress` returns newest first and `until` stops it at a signature already
   * seen, so a running service walks only the gap. The cursor is written **after** the pages are
   * processed, not during: a crash halfway then re-walks ground it already covered, which is free,
   * where the other order would skip a sale permanently.
   */
  async backfill(limit = 1000) {
    let until = this.store.cursor(CURSOR) || undefined
    const walk = async () => {
      const pages = []
      let before
      for (;;) {
        const page = await this.conn.getSignaturesForAddress(PROGRAM_ID, { before, until, limit: 1000 })
        if (!page.length) break
        pages.push(page)
        before = page[page.length - 1].signature
        if (pages.length * 1000 >= limit) break
        if (page.length < 1000) break
      }
      return pages.flat()
    }
    let sigs
    try {
      sigs = await walk()
    } catch (e) {
      /**
       * 🔴 A cursor the endpoint cannot resolve poisons EVERY future pass.
       *
       * `getSignaturesForAddress` does not ignore an `until` it has never heard of — it throws
       * `failed to get signatures for address: Transaction <sig> not found`. The cursor is written
       * from a log subscription, so it can name a transaction that never finalised, or one this
       * endpoint has pruned. The walk then fails, the cursor is never rewritten, and the next pass
       * fails identically: on mainnet this ran for 45 hours, 536 passes, every one of them dead,
       * with discovery resting entirely on the websocket. Found in `/api/health`, 18 Sep 2026.
       *
       * So an unusable cursor is DROPPED and the walk retried from the top. Re-walking ground
       * already covered is free — the store is keyed by address, and deposits by signature.
       */
      if (!until || !/not found/i.test(String(e?.message ?? e))) throw e
      this.note(new Error(`backfill cursor ${until.slice(0, 12)}… is unknown to the RPC; dropping it and re-walking`))
      this.store.setCursor(CURSOR, '')
      until = undefined
      sigs = await walk()
    }
    // Oldest first, so the newest signature is the last thing the cursor sees.
    for (const s of sigs.reverse()) {
      if (s.err) continue
      let tx
      try {
        tx = await this.conn.getTransaction(s.signature, {
          commitment: 'confirmed',
          maxSupportedTransactionVersion: MAX_TX_VERSION,
        })
      } catch (e) {
        // ⛔ One unreadable transaction must not abort the walk. It used to throw straight out of
        // `backfill`, which left the cursor unwritten — so the next pass re-walked the same
        // signatures, hit the same one, and the indexer never moved past it again.
        this.note(e)
        continue
      }
      const logs = tx?.meta?.logMessages
      if (!logs) continue
      for (const addr of salesOpened(logs)) {
        if (this.store.add(addr)) this.stats.discovered++
      }
      this.recordDeposits(s.signature, logs, tx.blockTime, tx.slot)
    }
    if (sigs.length) this.store.setCursor(CURSOR, sigs[sigs.length - 1].signature)
    this.stats.backfills++
    return sigs.length
  }

  /** Live discovery. A dropped socket is the web3.js client's problem; the backfill timer covers it. */
  subscribe() {
    this.subId = this.conn.onLogs(PROGRAM_ID, ({ logs, err, signature }) => {
      if (err) return
      for (const addr of salesOpened(logs)) {
        if (this.store.add(addr)) this.stats.discovered++
      }
      // A settling sale is re-read immediately rather than waiting for the next sweep — this is
      // the moment the listing is most visibly wrong if it lags.
      const settled = salesSettled(logs)
      if (settled.length) this.refresh(settled).catch(() => {})
      // A deposit needs the block time the chart plots against, and `onLogs` does not carry one.
      // Fetching the transaction is one extra call, and only on signatures that actually deposit.
      if (depositsIn(logs).length) this.ingest(signature).catch(() => {})
      this.store.setCursor(CURSOR, signature)
    }, 'confirmed')
    return this.subId
  }

  /** Records every deposit a log stream carries. Idempotent — keyed by signature in the store. */
  recordDeposits(signature, logs, blockTime, slot) {
    for (const d of depositsIn(logs)) {
      this.store.putDeposit(signature, d, blockTime, slot)
      this.stats.deposits++
    }
  }

  /** Pulls one transaction for its block time, then records what it deposited. */
  async ingest(signature) {
    const tx = await this.conn.getTransaction(signature, {
      commitment: 'confirmed', maxSupportedTransactionVersion: MAX_TX_VERSION,
    })
    const logs = tx?.meta?.logMessages
    if (logs) this.recordDeposits(signature, logs, tx.blockTime, tx.slot)
  }

  /**
   * Re-reads sale accounts. Batched at `opts.batch` — see the note there; it is NOT the
   * protocol's 100.
   *
   * An account that comes back null is counted as a miss rather than dropped: a single degraded
   * RPC response must not evict a live sale from the listing.
   */
  async refresh(addresses = this.store.addresses()) {
    try {
      const t = await this.conn.getBlockTime(await this.conn.getSlot('confirmed'))
      if (t !== null) this.chainTime = t
    } catch { /* keep the last good reading rather than falling back to the wrong clock */ }
    await this.refreshSolPrice()
    for (let i = 0; i < addresses.length; i += this.opts.batch) {
      const chunk = addresses.slice(i, i + this.opts.batch)
      const infos = await this.conn.getMultipleAccountsInfo(chunk.map((a) => new PublicKey(a)))
      const needPair = []
      chunk.forEach((addr, j) => {
        const info = infos[j]
        if (!info?.data) { this.store.miss(addr); return }
        try {
          const sale = decodeSale(info.data)
          // ⛔ Written by the program, at its own derived address — or it is not a sale, whatever
          // it decodes as. The listing is what every page and the watcher trust.
          if (!isProgramSale(addr, info, sale)) { this.store.miss(addr); return }
          this.store.put(addr, sale)
          if (sale.pair && !this.store.pairOf(addr)) needPair.push(addr)
          this.stats.refreshed++
        } catch {
          // Not a sale account — an address that reached the store by mistake. Ages out as a miss.
          this.store.miss(addr)
        }
      })
      // A pair sale's token lives in its own account, written once at open; read it once.
      if (needPair.length) {
        try {
          const pairs = await this.conn.getMultipleAccountsInfo(needPair.map((a) => pairAddress(new PublicKey(a))))
          pairs.forEach((p, j) => { if (p?.data) this.store.setPair(needPair[j], decodePair(p.data).mint.toBase58()) })
        } catch (e) { this.note(e) }
      }
    }
    return addresses.length
  }

  /**
   * Prices every launched coin, from whichever account can actually price it.
   *
   * ⛔ A launched coin has TWO homes and they do not overlap: pump.fun's bonding curve until it
   * graduates, and an AMM pool afterwards. A migrated curve reads all zeroes, so pricing one from
   * the curve reports a real coin as worth **0** — which is why `marketCapFromCurve` refuses a
   * completed curve rather than doing the arithmetic. See `market.mjs`.
   *
   * What is written per sale:
   *   `curve`     live on the bonding curve, cap from its virtual reserves
   *   `migrated`  the curve is complete; cap from the pool, or null if the pool could not be read
   *   `unknown`   launched, but the curve account did not come back — NOT worth zero
   *
   * ⚠ The cap is null rather than 0 whenever nothing could price the coin, and every consumer has
   * to carry that distinction: "unreadable" and "worthless" look identical once a null becomes a 0.
   */
  /**
   * Re-reads the swap pool's two vaults and prices SOL in USDC.
   *
   * Three accounts per pass (the pool, then its vaults), and the pool's own address is pinned in
   * the program — the same one a deposit is converted at, so the site and the chain agree.
   */
  async refreshSolPrice() {
    try {
      if (!this.poolVaults) {
        const pool = await this.conn.getAccountInfo(SWAP_POOL)
        if (!pool?.data) return
        this.poolVaults = poolVaults(pool.data)
      }
      const [sv, uv] = await this.conn.getMultipleAccountsInfo([this.poolVaults.solVault, this.poolVaults.usdcVault])
      if (!sv?.data || !uv?.data) return
      const price = solUsdFromReserves(sv.data.readBigUInt64LE(64), uv.data.readBigUInt64LE(64))
      // A pool that reads as empty, or a decode that lands on the wrong bytes, must not become a
      // price. Anything outside this range is not SOL, and the last good reading is better.
      if (price && price > 1 && price < 100_000) this.solUsd = price
    } catch (e) { this.note(e) }
  }

  /**
   * Prices **Pump Family's own token**, which no `Sale` account will ever describe.
   *
   * ⛔⛔ It is launched on ANOTHER platform, so there is no window, no deposit address and no
   * position — and this must not invent any. All that is read from the chain is what a chain can
   * answer: where the coin trades and what it is worth. Its name, ticker and logo are ours and
   * are served from the site, so the page does not depend on a third party's metadata surviving.
   *
   * ⚠ `FAMILY_MINT` unset is the normal state until the coin exists. The whole feature is then
   * simply absent — no placeholder row, no "coming soon" with a price of zero.
   *
   * ⛔ `cap: null` means nothing could price it, which the listing shows as unknown. A coin that
   * has graduated reads all zeroes off its curve, so the same three-phase rule as every other
   * launched coin applies — see `market.mjs`.
   */
  async refreshFamily() {
    const mintStr = (process.env.FAMILY_MINT ?? '').trim()
    if (!mintStr) { this.family = null; return }
    let mint
    try { mint = new PublicKey(mintStr) } catch { this.family = null; return }
    const prev = this.family
    try {
      const curveAcc = await this.conn.getAccountInfo(bondingCurveAddress(mint))
      if (!curveAcc?.data) {
        // Not a pump.fun coin at all, or not one yet. It is still OUR token and still gets a row;
        // it just has no price this service knows how to read.
        this.family = { mint: mintStr, state: 'unknown', cap: null, pool: prev?.pool ?? null }
        return
      }
      const curve = decodeBondingCurve(curveAcc.data)
      const quote = curve.quoteMint ? 'usdc' : 'sol'
      if (!curve.complete) {
        this.family = { mint: mintStr, state: 'curve', cap: marketCapFromCurve(curve, quote), pool: null }
        return
      }
      const { cap, pool } = await this.poolPrice({ mint: mintStr, pool: prev?.pool ?? null, quote_mint: null }, quote)
      this.family = { mint: mintStr, state: 'migrated', cap, pool }
    } catch (e) {
      // ⛔ Leave the last good reading in place rather than replacing it with a worse one. An RPC
      // that failed is not news about the coin.
      this.note(e)
      this.family = prev ?? { mint: mintStr, state: 'unknown', cap: null, pool: null }
    }
  }

  /**
   * The custom-pair list: pump.fun's own `quote-control` account for WHICH tokens, Jupiter's token
   * API for what they are called, what they look like and what they are worth.
   *
   * ⚠ Jupiter is display data only. Nothing that moves money reads it: the program checks the
   * pair against pump.fun's account itself, and the watcher asks Jupiter for a ROUTE, not a price.
   */
  async refreshPairs(force = false) {
    if (!force && Date.now() - this.pairsAt < this.opts.pairsMs) return
    try {
      const info = await this.conn.getAccountInfo(QUOTE_CONTROL)
      if (!info?.data) return
      const mints = decodeQuoteControl(info.data).map((e) => e.mint.toBase58())
      const next = new Map()
      // ⚠ NOT an RPC read, so `RPC_BATCH` does not apply: Jupiter's token search takes up to 100
      // mints per call, and 168 in chunks of ten would be seventeen requests to a rate-limited API.
      for (let i = 0; i < mints.length; i += JUPITER_TOKENS_BATCH) {
        const r = await fetch(`${this.opts.jupiterTokens}?query=${mints.slice(i, i + JUPITER_TOKENS_BATCH).join(',')}`)
        if (!r.ok) throw new Error(`Jupiter tokens answered ${r.status}`)
        for (const t of await r.json()) {
          if (!mints.includes(t.id)) continue
          next.set(t.id, {
            mint: t.id, symbol: String(t.symbol ?? '').slice(0, 16), name: String(t.name ?? '').slice(0, 48),
            icon: typeof t.icon === 'string' && /^https:\/\//i.test(t.icon) ? t.icon.slice(0, 300) : null,
            decimals: Number(t.decimals), tokenProgram: t.tokenProgram ?? null,
            usdPrice: Number(t.usdPrice) > 0 ? Number(t.usdPrice) : null,
            liquidity: Number(t.liquidity) > 0 ? Math.round(Number(t.liquidity)) : 0,
          })
        }
      }
      // A token Jupiter does not know is still on pump.fun's list and still launchable: it keeps a
      // row, with nothing but its address.
      for (const m of mints) if (!next.has(m)) next.set(m, { mint: m, symbol: null, name: null, icon: null, decimals: null, tokenProgram: null, usdPrice: null, liquidity: 0 })
      this.pairs = next
      this.pairsAt = Date.now()
    } catch (e) { this.note(e) }
  }

  /**
   * A pair coin's cap in SOL, so every page that shows dollars through `solUsd` keeps working.
   * ⛔ `null`, not a guess, when either price or the pair's decimals are unknown.
   */
  pairCapInSol(virtualQuote, virtualToken, pairMint) {
    const p = this.pairs.get(pairMint.toBase58())
    if (!p?.usdPrice || !Number.isInteger(p.decimals) || !this.solUsd) return null
    const vq = Number(virtualQuote) / 10 ** p.decimals, vt = Number(virtualToken) / 1e6
    if (!(vq > 0) || !(vt > 0)) return null
    return (vq / vt) * (Number(SUPPLY) / 1e6) * p.usdPrice / this.solUsd
  }

  async refreshMarkets() {
    const rows = this.store.launched()
    if (!rows.length) return 0
    let priced = 0
    for (let i = 0; i < rows.length; i += this.opts.batch) {
      const chunk = rows.slice(i, i + this.opts.batch)
      let infos
      try {
        infos = await this.conn.getMultipleAccountsInfo(chunk.map((r) => bondingCurveAddress(new PublicKey(r.mint))))
      } catch (e) {
        // One failed read must not rewrite good state. Leave the rows as they are and try again.
        this.note(e)
        continue
      }
      for (let j = 0; j < chunk.length; j++) {
        const row = chunk[j]
        const info = infos[j]
        try {
          if (!info?.data) { this.store.putMarket(row.address, { state: 'unknown', cap: null, pool: row.pool }); continue }
          const curve = decodeBondingCurve(info.data)
          /**
           * 🔴 The unit comes from the COIN, not from what buyers paid.
           *
           * A sale collects USDC and launches a SOL-paired coin, so `row.quote` ('usdc') is the
           * deposit asset and says nothing about the curve. pump.fun's own account does: a
           * quote-mint coin names its mint, a SOL coin leaves it empty. Reading the sale's field
           * here priced a 30-SOL curve as 30 billion USDC — a number wrong by the SOL price, and
           * plausible enough to ship.
           */
          // ⭐ A custom pair: pump.fun names the pair token as the curve's quote. Its cap is in THAT
          // token, converted to SOL here so the rest of the site, which speaks SOL + solUsd, is
          // unchanged.
          const isPair = curve.quoteMint && !curve.quoteMint.equals(USDC_MINT)
          if (isPair) {
            if (!curve.complete) {
              this.store.putMarket(row.address, { state: 'curve', cap: this.pairCapInSol(curve.virtualQuote, curve.virtualToken, curve.quoteMint), pool: row.pool })
              priced++
              continue
            }
            const { cap, pool } = await this.poolPrice(row, 'pair', curve.quoteMint)
            this.store.putMarket(row.address, { state: 'migrated', cap, pool })
            priced++
            continue
          }
          const quote = curve.quoteMint ? 'usdc' : 'sol'
          if (!curve.complete) {
            this.store.putMarket(row.address, { state: 'curve', cap: marketCapFromCurve(curve, quote), pool: row.pool })
            priced++
            continue
          }
          const { cap, pool } = await this.poolPrice(row, quote)
          this.store.putMarket(row.address, { state: 'migrated', cap, pool })
          priced++
        } catch (e) { this.note(e) }
      }
    }
    return priced
  }

  /**
   * A migrated coin's cap, from its pool.
   *
   * The pool address is DERIVED rather than searched for: `getProgramAccounts` is blocked on this
   * endpoint, and a derived address needs no index at all. Once found it is cached on the row, so
   * the walk over `POOL_INDEXES` happens once per coin rather than every sweep.
   *
   * ⚠ Returns `{ cap: null }` when the pool cannot be read. That is a coin whose price is unknown,
   * which the listing must show as unknown.
   */
  async poolPrice(row, quote, pairMint = null) {
    const mint = new PublicKey(row.mint)
    // A SOL coin migrates into a WSOL pool; a quote-mint coin into one paired with its own mint;
    // a custom-pair coin into one paired with its pair token.
    const quoteMint = pairMint ?? new PublicKey(quote === 'sol' ? WSOL : (row.quote_mint ?? WSOL))
    const candidates = row.pool
      ? [new PublicKey(row.pool)]
      : POOL_INDEXES.map((n) => poolAddress(mint, quoteMint, n))
    let infos
    try { infos = await this.conn.getMultipleAccountsInfo(candidates) } catch (e) { this.note(e); return { cap: null, pool: row.pool } }
    for (let i = 0; i < candidates.length; i++) {
      if (!infos[i]?.data) continue
      let pool
      try { pool = decodePool(infos[i].data) } catch { continue }
      // A derived address that decodes could still be some other pair's pool if a seed were wrong,
      // so the mints are checked against the coin rather than assumed.
      if (!pool.baseMint.equals(mint) || !pool.quoteMint.equals(quoteMint)) continue
      let reserves
      try { reserves = await this.conn.getMultipleAccountsInfo([pool.baseAccount, pool.quoteAccount]) }
      catch (e) { this.note(e); return { cap: null, pool: candidates[i].toBase58() } }
      const [b, q] = reserves
      if (!b?.data || !q?.data) return { cap: null, pool: candidates[i].toBase58() }
      const cap = pairMint
        ? this.pairCapInSol(tokenAccountAmount(q.data), tokenAccountAmount(b.data), pairMint)
        : marketCapFromPool(tokenAccountAmount(b.data), tokenAccountAmount(q.data), quote)
      return { cap, pool: candidates[i].toBase58() }
    }
    return { cap: null, pool: row.pool ?? null }
  }

  /**
   * Resolves each sale's off-chain metadata once, for the image the listing shows.
   *
   * Done here rather than in the browser: a grid of 200 sales would otherwise be 200 IPFS fetches
   * from every visitor, and IPFS gateways are slow and rate limited. The result is recorded either
   * way — a URI that 404s is tried once and then left alone, so a dead link cannot become a
   * request on every sweep forever.
   *
   * ⚠ This fetches URLs chosen by whoever opened the sale. It reads a bounded amount of JSON and
   * stores only `image` and `description`; it never follows anything else the document contains,
   * and the image URL is passed to the browser as a URL, never fetched server-side.
   */
  async resolveMetadata(limit = 20) {
    const now = Math.floor(Date.now() / 1000)
    for (const row of this.store.pendingMetadata(limit, now)) {
      const tries = row.tries ?? 0
      /**
       * ⛔⛔ Park it, do not bury it. `failed` is never looked at again, so recording a transient
       * failure there costs the token its image on this site FOREVER. Measured 21 Sep 2026:
       * `ipfs.io` answered **429 on seven of eight** real pump.fun metadata URIs from this
       * machine. Under the old rule that was seven permanently image-less tokens.
       *
       * Backoff is 1, 4, 16, 64 minutes and so on, and after ATTEMPTS tries it settles as failed
       * for real — a link that is actually dead must not be fetched every sweep forever, which is
       * the hazard the original comment was right about.
       */
      const park = () => {
        const settled = tries + 1 >= METADATA_ATTEMPTS
        this.store.putMetadata(row.address, {}, settled ? 'failed' : 'retry',
                               settled ? null : now + 60 * 4 ** Math.min(tries, 4))
      }
      let doc = null
      try {
        doc = await fetchMetadataDocument(row.uri)
      } catch { park(); continue }
      // A definite "this is not there" — settled, no retry. Anything else already parked above.
      if (doc === NOT_FOUND) { this.store.putMetadata(row.address, {}, 'failed', null); continue }
      if (!doc) { park(); continue }

      let meta
      try { meta = JSON.parse(doc) } catch {
        // A document that is not JSON will not become JSON. Settled.
        this.store.putMetadata(row.address, {}, 'failed', null); continue
      }
      // Only http(s) URLs survive, and only at a bounded length. These strings are written by
      // whoever opened the sale and end up as hrefs in a browser, so anything that is not
      // plainly a web address is dropped rather than sanitised.
      const url = (v, max = 400) =>
        typeof v === 'string' && /^https?:\/\//.test(v) ? v.slice(0, max) : null
      // ⛔ The image is the exception: an `ipfs://` image is a PERFECTLY GOOD image that this
      // rule used to drop on the floor, leaving the row `ok` with no picture — the one failure
      // shape that never retries and never looks broken. It is rewritten to a gateway instead.
      // ⛔ `gatewayFor` FIRST, not as a fallback: `url()` would happily pass through an
      // `https://ipfs.io/ipfs/…` image, which is a well-formed URL to a host that rate-limits.
      const image = url(gatewayFor(meta.image))
      const description = typeof meta.description === 'string' ? meta.description.slice(0, 500) : null
      this.store.putMetadata(row.address, {
        image, description,
        twitter: url(meta.twitter, 200),
        telegram: url(meta.telegram, 200),
        website: url(meta.website, 200),
      }, 'ok', null)
      this.stats.metadata++
    }
  }

  async start() {
    await this.backfill().catch((e) => this.note(e))
    await this.refresh().catch((e) => this.note(e))
    this.subscribe()
    await this.resolveMetadata().catch((e) => this.note(e))
    await this.refreshPairs(true).catch((e) => this.note(e))
    await this.refreshMarkets().catch((e) => this.note(e))
    await this.refreshFamily().catch((e) => this.note(e))
    this.timers.push(setInterval(
      () => this.refresh()
        .then(() => this.resolveMetadata())
        .then(() => this.refreshPairs())
        .then(() => this.refreshMarkets())
        .then(() => this.refreshFamily())
        .catch((e) => this.note(e)),
      this.opts.refreshMs))
    this.timers.push(setInterval(() => this.backfill().catch((e) => this.note(e)), this.opts.backfillMs))
    return this
  }

  note(e) {
    this.stats.errors++
    this.stats.lastError = String(e?.message ?? e)
    console.error('[indexer]', this.stats.lastError)
  }

  async stop() {
    this.timers.forEach(clearInterval)
    this.timers = []
    if (this.subId !== null) { try { await this.conn.removeOnLogsListener(this.subId) } catch { /* closing */ } }
    this.store.close()
  }
}
