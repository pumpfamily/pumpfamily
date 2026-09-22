/**
 * The read API the site lists sales from.
 *
 * Serves only what the indexer last read off chain, with the timestamp it read it. A client that
 * cares about exactness reads the sale account itself — this is a listing, and it says how old it
 * is rather than pretending to be live.
 */
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { Indexer } from './indexer.mjs'
import { isGenuineSale } from '../program.mjs'

/**
 * The attester's balance, as the watcher last wrote it.
 *
 * ⚠ Read fresh on every request rather than cached: it is one small file, the endpoint is not hot,
 * and a cached figure that outlives the watcher is exactly the lie this is meant to prevent.
 *
 * ⛔ Anything unreadable, unparseable or STALE is `null` — "unknown", never "fine". A watcher that
 * died an hour ago leaves a file saying 0.3 SOL, and reporting that as current would be worse than
 * reporting nothing.
 */
const ATTESTER_STATUS_FILE = process.env.ATTESTER_STATUS_FILE ?? '/root/pumpfamily-app/data/attester.json'
const ATTESTER_STALE_SECONDS = Number(process.env.ATTESTER_STALE_SECONDS ?? 600)
function attesterStatus() {
  try {
    const j = JSON.parse(readFileSync(ATTESTER_STATUS_FILE, 'utf8'))
    const age = Math.floor(Date.now() / 1000) - (j.at ?? 0)
    if (!Number.isFinite(age) || age > ATTESTER_STALE_SECONDS) return null
    // ⛔ The address is public (it is compiled into the program) — the KEY is not here and never
    // passes through this process.
    return { address: j.address, sol: j.sol, buyers: j.buyers, low: j.low === true, ageSeconds: age }
  } catch { return null }
}

/** An RPC url reduced to something safe to publish: its host, and nothing else. */
const rpcHost = (url) => { try { return new URL(url).host } catch { return 'invalid' } }

const PORT = Number(process.env.PORT || 5241)
/**
 * Loopback by default.
 *
 * `listen(port)` alone binds every interface, which on a shared box means this service is
 * reachable from the internet on its own port — bypassing the vhost that is supposed to be the
 * only way in, and exposing it under a hostname with no certificate. Every other service on that
 * machine binds 127.0.0.1; this now does too. Set HOST explicitly to override.
 */
const HOST = process.env.HOST || '127.0.0.1'

/**
 * Sales kept out of the public LISTINGS — `HIDDEN_SALES`, comma-separated addresses.
 *
 * ⭐ Listings only. `/api/sales/<address>` and the history still answer in full, because the sale
 * itself has to keep working for whoever holds the link: a hidden sale is one that does not belong
 * on the front page, not one that is broken. Our own test sales are the case this exists for.
 *
 * ⛔ It hides a ROW, not a coin. A launched coin is on pump.fun's curve and trades whether or not
 * this list names it; nothing here can undo a launch.
 *
 * ⛔⛔ And it must not reach the WATCHER. The watcher takes its entire work list from `/api/sales`,
 * so while this filtered that call unconditionally, hiding a sale also stopped it being credited,
 * launched, delivered and refunded — a display setting freezing buyers' money, with every health
 * check green because nothing failed, nothing ran. The watcher now asks with `?hidden=1`, which it
 * forces itself rather than reading from config. Pinned by indexer.test.mjs.
 */
let hiddenCache = { raw: null, set: new Set() }
const hidden = () => {
  // ⚠ Read per call, not once at import: a module-level constant cannot be exercised by a test
  // that runs in the same process, and this is exactly the kind of setting that gets changed and
  // never proved. Memoised on the string itself, so the parse happens once per distinct value.
  const raw = process.env.HIDDEN_SALES ?? ''
  if (raw !== hiddenCache.raw) hiddenCache = { raw, set: new Set(raw.split(',').map((s) => s.trim()).filter(Boolean)) }
  return hiddenCache.set
}

/** What the public listings show: a genuine USDC sale that is not on the hidden list. */
const listed = (r) => isGenuineSale({ quoteLabel: r.quote, quoteMint: r.quote_mint }) && !hidden().has(r.address)

/** Open, closed-but-unlaunched, and settled are three different things to a depositor. */
/**
 * Pump Family's own token, shaped like a listing row so every page that renders sales renders it
 * too, with no special case.
 *
 * ⛔⛔ It is NOT a sale and must never be counted as one. It has no window, no deposit address,
 * no buyers and no position — those fields are null rather than zero, because a zero would read
 * as "nobody bought" instead of "this was never that kind of thing". `/api/stats` leaves it out
 * entirely: counting it as a launch would inflate the number the front page shows.
 *
 * ⚠ Name, ticker and image come from THIS service, not from the platform the coin was launched
 * on. If that platform's metadata moves or rots, our own token still renders.
 */
const FAMILY_MINT = (process.env.FAMILY_MINT ?? '').trim()
const FAMILY_NAME = process.env.FAMILY_NAME ?? 'Pump Family'
const FAMILY_SYMBOL = process.env.FAMILY_SYMBOL ?? 'FAMILY'
const FAMILY_IMAGE = process.env.FAMILY_IMAGE ?? '/family.png'

function familyRow(indexer, now) {
  if (!FAMILY_MINT) return null
  const m = indexer.family
  return {
    // ⚠ Keyed by its MINT, because it has no sale address. Every link to it is /token/<mint>.
    address: FAMILY_MINT,
    mint: FAMILY_MINT,
    name: FAMILY_NAME,
    symbol: FAMILY_SYMBOL,
    image: FAMILY_IMAGE,
    /** ⭐ What marks it out everywhere: this is ours, and it did not come through a window. */
    featured: true,
    phase: m?.state === 'migrated' ? 'migrated' : 'launched',
    marketState: m?.state ?? 'unknown',
    marketCap: m?.cap ?? null,
    pool: m?.pool ?? null,
    quoteLabel: 'sol',
    // ⛔ null, not 0 — see above.
    gross: null, solExpected: null, solIn: null,
    sold: null, depositors: null, windowEnd: null, launchDeadline: null,
    hardCap: null, minRaise: null, perWalletCap: null, uri: null, description: null,
    twitter: null, telegram: null, website: null, authority: null, creatorFeeRecipient: null,
    holderRewards: null, status: 1, spark: [], firstSeen: null, ageSeconds: null,
  }
}

function phaseOf(row, now) {
  // A migrated coin is still `launched` on chain — the program has no idea pump.fun graduated it.
  // It is a separate phase here because it is priced from a different account and listed on its
  // own tab. ⚠ Sticky by nature: `complete` is never cleared, so this never goes backwards.
  if (row.status === 1 && row.market_state === 'migrated') return 'migrated'
  if (row.status === 1) return 'launched'
  if (row.status === 2) return 'failed'
  if (now < row.window_end) return 'open'
  // Closed below its minimum: it will refund, not launch. Same rule as web/src/token.jsx.
  if (Number(row.gross) < Number(row.min_raise)) return 'failing'
  if (now < row.launch_deadline) return 'awaiting-launch'
  return 'expired'
}

let pairView = (mint) => ({ mint, symbol: null, icon: null })
const view = (row, now, spark) => ({
  address: row.address,
  mint: row.mint,
  name: row.name,
  symbol: row.symbol,
  uri: row.uri,
  /**
   * Where this coin's creator fee goes, chosen when the sale opened and permanent from launch.
   *
   * ⚠ `null` on a row written before this column existed — which is different from `false`, and
   * the page must say nothing rather than claim "to the creator" on a sale it cannot read.
   */
  holderRewards: row.holder_rewards === null || row.holder_rewards === undefined
    ? null : row.holder_rewards === 1,
  image: row.image,
  description: row.description,
  twitter: row.twitter,
  telegram: row.telegram,
  website: row.website,
  authority: row.authority,
  creatorFeeRecipient: row.creator_fee_recipient,
  spark,
  phase: phaseOf(row, now),
  /**
   * Market cap **in SOL**, priced from whichever account can actually price the coin — see
   * `market.mjs`.
   *
   * ⛔ NOT in the sale's quote. Buyers pay USDC and the raise is swapped at the close, so the coin
   * trades on pump.fun's SOL curve: the money and the market are different assets now, and the
   * unit is read off the COIN (a quote-mint coin names its mint; a SOL one does not).
   *
   * ⛔ **`null` means nothing could price it**, which is not the same as zero and must never be
   * rendered as one. It is null for a sale that has not launched (the browser prices those off the
   * shadow curve, which needs no RPC), and for a launched coin whose curve or pool did not read.
   */
  marketCap: row.market_cap ?? null,
  /**
   * The custom liquidity token this coin is paired with on pump.fun, or null for SOL. ⭐ The cap
   * above is still in SOL either way — a pair coin's is converted by the indexer.
   */
  pair: row.pair_mint ? pairView(row.pair_mint) : null,
  /** 'curve' · 'migrated' · 'unknown', or null before launch. */
  marketState: row.market_state ?? null,
  /** The AMM pool a migrated coin trades in, once found. */
  pool: row.pool ?? null,
  status: row.status,
  windowEnd: row.window_end,
  launchDeadline: row.launch_deadline,
  hardCap: row.hard_cap,
  minRaise: row.min_raise,
  perWalletCap: row.per_wallet_cap,
  /**
   * ⚠ What buyers PAY IN — 'usdc' — and nothing else. It is the unit of `gross` and of a refund.
   *
   * ⛔ It is NOT the unit of `marketCap`, nor of `hardCap` / `perWalletCap` / `minRaise`, which are
   * the SOL curve's and therefore lamports. One field cannot answer both questions, and treating
   * it as if it could is what printed a 30-SOL curve as 30 billion USDC.
   */
  quoteLabel: row.quote ?? 'sol',
  quoteMint: row.quote_mint ?? null,
  gross: row.gross,
  // ⛔ The SOL side of the raise, and NOT derivable from `gross` by anyone downstream: `gross` is
  // USDC, `solExpected` is what the program itself booked each deposit as at the pool's rate, and
  // `solIn` is what the swap at the close really returned. Served because the sale page falls back
  // to this row when a chain read fails, and zeroes here read as "raised nothing".
  solExpected: row.sol_expected ?? 0,
  solIn: row.sol_in ?? 0,
  sold: row.sold,
  depositors: row.depositors,
  // When the indexer first saw this sale. Not the sale's on-chain creation time — nothing records
  // that — but it orders "newest first" correctly for anything opened while the index was running,
  // and backfilled sales sort by the order history returned them, which is the same order.
  firstSeen: Math.round(row.first_seen / 1000),
  // How stale this row is, in seconds. Stated rather than hidden.
  ageSeconds: Math.round((Date.now() - row.refreshed) / 1000),
})

/**
 * The launch form's image + metadata upload, passed through to pump.fun.
 *
 * ⛔ Why it exists: pump.fun's `/api/ipfs` sends no `Access-Control-Allow-Origin`, so a browser on
 * pump.family can POST to it but can never read the answer — the form would upload and then fail.
 * Measured 16 Sep 2026: preflight 204, POST 200, no CORS header on either.
 *
 * It is a PUBLIC write endpoint, so it is strict: POST only, the body is cut off mid-stream past
 * `MAX_UPLOAD`, the file must BE a PNG, JPEG, GIF or WebP by its magic bytes (never by the name or
 * the declared type — and never SVG, which is a script), and only the known text fields go on.
 * One upload per IP per `UPLOAD_GAP_MS`.
 */
const MAX_UPLOAD = 4 * 1024 * 1024
const UPLOAD_GAP_MS = 5_000
const lastUpload = new Map()
const FIELDS = ['name', 'symbol', 'description', 'twitter', 'telegram', 'website']
const isImage = (b) =>
  (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) ||                 // PNG
  (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) ||                                    // JPEG
  (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) ||                   // GIF
  (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
   b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50)                   // WebP

async function ipfsUpload(req, res, send, upstream = process.env.IPFS_UPSTREAM || 'https://pump.fun/api/ipfs') {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'POST', 'access-control-allow-headers': 'content-type' })
    return res.end()
  }
  if (req.method !== 'POST') return send(res, 405, { error: 'POST only' })
  // Behind Caddy the peer is loopback; the client is the first X-Forwarded-For hop.
  const ip = (req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() || req.socket.remoteAddress
  const now = Date.now()
  if (now - (lastUpload.get(ip) ?? 0) < UPLOAD_GAP_MS) return send(res, 429, { error: 'one upload every few seconds' })
  lastUpload.set(ip, now)
  if (lastUpload.size > 10_000) lastUpload.clear()

  const chunks = []
  let size = 0
  try {
    for await (const c of req) {
      size += c.length
      if (size > MAX_UPLOAD) { req.destroy(); return send(res, 413, { error: 'image too large (4 MB max)' }) }
      chunks.push(c)
    }
  } catch { return send(res, 400, { error: 'upload interrupted' }) }

  let form
  try {
    form = await new Request('http://local/', { method: 'POST', headers: { 'content-type': req.headers['content-type'] ?? '' }, body: Buffer.concat(chunks) }).formData()
  } catch { return send(res, 400, { error: 'expected multipart form data' }) }
  const file = form.get('file')
  if (!file || typeof file === 'string') return send(res, 400, { error: 'an image file is required' })
  const bytes = new Uint8Array(await file.arrayBuffer())
  if (!isImage(bytes)) return send(res, 415, { error: 'the image must be PNG, JPEG, GIF or WebP' })

  const out = new FormData()
  out.append('file', new Blob([bytes], { type: file.type || 'application/octet-stream' }), 'image')
  for (const f of FIELDS) {
    const v = form.get(f)
    if (typeof v === 'string' && v.length <= 1000) out.append(f, v)
  }
  out.append('showName', 'true')
  try {
    const r = await fetch(upstream, { method: 'POST', body: out })
    const text = await r.text()
    if (!r.ok) return send(res, 502, { error: `pump.fun upload failed: HTTP ${r.status}` })
    return send(res, 200, JSON.parse(text))
  } catch (e) { return send(res, 502, { error: `pump.fun upload failed: ${e.message}` }) }
}

export function serve(indexer, port = PORT) {
  // The pair's name and logo come from the indexer's pair list, which is refreshed on its own.
  pairView = (mint) => {
    const p = indexer.pairs?.get(mint)
    return { mint, symbol: p?.symbol ?? null, name: p?.name ?? null, icon: p?.icon ?? null }
  }
  const send = (res, code, body) => {
    const s = JSON.stringify(body)
    res.writeHead(code, {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
      'cache-control': 'no-store',
    })
    res.end(s)
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')

    if (url.pathname === '/api/ipfs') return ipfsUpload(req, res, send)
    // The chain's clock, not the host's — see `Indexer.chainTime`. Falls back to the host clock
    // only before the first refresh has landed, when there is nothing to serve anyway.
    const now = indexer.chainTime ?? Math.floor(Date.now() / 1000)

    /**
     * pump.fun's custom-pair tokens for the launch form, deepest first. ⭐ Every token on the list
     * is offered, exactly as pump.fun's own form does; liquidity only orders them.
     */
    if (url.pathname === '/api/pairs') {
      const pairs = [...indexer.pairs.values()].sort((a, b) => b.liquidity - a.liquidity)
      return send(res, 200, { pairs, count: pairs.length, solUsd: indexer.solUsd })
    }
    if (url.pathname === '/api/health') {
      const rows = indexer.store.all().filter(listed)
      return send(res, 200, {
        ok: indexer.stats.refreshed > 0 || rows.length === 0,
        // ⛔ The HOST only, never the url. Every paid Solana provider — Helius, Triton,
        // QuickNode — puts the API key in the URL itself, and this endpoint is public through
        // the site's vhost, so returning `opts.rpc` publishes the key to anyone who asks for
        // /api/health. Which is the whole internet.
        rpc: rpcHost(indexer.opts.rpc),
        sales: rows.length,
        solUsd: indexer.solUsd,
        chainTime: indexer.chainTime,
        // Positive means the chain's clock is behind the host's. Large and growing is worth
        // knowing about; it is what makes a wall-clock listing wrong.
        clockSkewSeconds: indexer.chainTime === null ? null : Math.floor(Date.now() / 1000) - indexer.chainTime,
        /**
         * The attester's balance, as the WATCHER last saw it.
         *
         * ⛔⛔ It pays for every credit, return and delivery — about 0.0045 SOL per buyer. Run it
         * dry mid-delivery and buyers who paid simply are not sent their tokens: nothing reverts,
         * nothing errors, and this endpoint used to report a perfectly healthy launchpad.
         *
         * ⚠ `null` means the watcher has not written it (not running, or too old to trust) — which
         * is "unknown", not "fine". A monitor should treat a missing figure as worth asking about.
         */
        attester: attesterStatus(),
        ...indexer.stats,
        uptimeSeconds: Math.round((Date.now() - indexer.stats.since) / 1000),
      })
    }

    /** The token's own page reads this. ⛔ Checked BEFORE the sale lookup: it has no sale. */
    if (url.pathname === '/api/family') {
      const family = familyRow(indexer, now)
      if (!family) return send(res, 404, { error: 'no family token configured' })
      return send(res, 200, { ...family, solUsd: indexer.solUsd })
    }

    if (url.pathname === '/api/stats') {
      const rows = indexer.store.all().filter(listed).map((r) => view(r, now))
      const sum = (f) => rows.reduce((a, r) => a + (r[f] || 0), 0)
      /**
       * ⭐ Our own token counts as a launch.
       *
       * ⚠ This reverses an earlier decision here, deliberately and on the operator's call. The
       * argument for excluding it was that it did not come through a window, so counting it would
       * inflate the number. The argument for including it is simpler and wins: the front page
       * SHOWS it as one of the launches, in the same grid and the same table, so a counter beside
       * that grid reading one fewer is the number that is wrong.
       *
       * ⛔ It must never add MONEY. `raised` and `depositors` sum over `rows`, which does not
       * contain it. `volume` sums over `launched`, which now does — and it contributes exactly
       * zero because its `gross` is null, not 0: a coin that never had a window did not raise
       * nothing, it was never that kind of thing. Both readings give the same figure here; the
       * distinction matters the day someone adds a field that treats null differently.
       */
      const family = familyRow(indexer, now)
      /**
       * ⛔⛔ `migrated` COUNTS. A graduated coin is a launch that then went on to graduate — it is
       * the best outcome this launchpad has, and it was the one state the counter did not count.
       * `phaseOf` returns 'migrated' instead of 'launched' once the curve is complete, so the
       * figure silently went DOWN by one every time a coin succeeded.
       *
       * ⚠ It matters twice: `volume` sums over this list, so a graduated coin's raise was missing
       * from the total as well.
       *
       * ⛔ Still not `awaiting-launch` (no coin exists yet) and never `failed` (no coin was ever
       * created, and the money went back). A landing page counting those as launches is the sort
       * of number nobody checks until somebody does.
       */
      const isLaunch = (r) => r.phase === 'launched' || r.phase === 'migrated'
      const launched = [...rows.filter(isLaunch), ...(family ? [family] : [])]
      const sumOf = (list, f) => list.reduce((a, r) => a + (r[f] || 0), 0)
      return send(res, 200, {
        // ⚠ `launches` counted every sale ever OPENED, including ones that failed and refunded.
        // A coin that was never created is not a launch, and a landing page saying otherwise is
        // the sort of number nobody checks until someone does.
        launches: launched.length,
        sales: rows.length + (family ? 1 : 0),
        open: rows.filter((r) => r.phase === 'open').length,
        awaitingLaunch: rows.filter((r) => r.phase === 'awaiting-launch').length,
        launched: launched.length,
        /**
         * SOL that has actually bought coins through Pump Family.
         *
         * Only LAUNCHED sales count. A failed sale's deposits were refunded in full, so counting
         * them would be counting a round trip as volume — the money came back.
         *
         * ⛔ This is volume THROUGH THE LAUNCHPAD, not the trading volume of the coins after they
         * reach pump.fun. That second number needs an indexer subscribed to every launched mint's
         * curve, which this is not.
         */
        // Base units of the quote. Every sale is USDC now, so these are 6-decimal USDC.
        volume: sumOf(launched, 'gross'),
        raised: sum('gross'),
        depositors: sum('depositors'),
      })
    }

    if (url.pathname === '/api/sales') {
      const wanted = url.searchParams.get('phase')
      /**
       * ⛔⛔ `?hidden=1` INCLUDES sales that `HIDDEN_SALES` keeps out of the public listing, and
       * the watcher must use it.
       *
       * The watcher takes its entire work list from this endpoint. Filtered, hiding a sale did
       * not just remove a row from Explore — it removed that sale from the watcher, which then
       * stopped crediting FOMO sends, stopped launching it at the close, stopped delivering
       * tokens and stopped pushing refunds. A cosmetic setting, quietly freezing buyers' money,
       * on a system reporting itself healthy.
       *
       * ⚠ It publishes nothing secret: a hidden sale's address is on chain and its own page has
       * always answered. Hiding is about the shop window, and was never meant to be a switch that
       * reaches the machinery.
       */
      const includeHidden = url.searchParams.get('hidden') === '1'
      // One query for every sparkline, not one per row — see `sparks()`.
      const sparks = indexer.store.sparks()
      const visible = includeHidden
        ? (r) => isGenuineSale({ quoteLabel: r.quote, quoteMint: r.quote_mint })
        : listed
      let rows = indexer.store.all().filter(visible).map((r) => view(r, now, sparks[r.address] ?? []))
      if (wanted) rows = rows.filter((r) => r.phase === wanted)
      // Open sales first and closing soonest at the top: the ordering a depositor acts on.
      const rank = { open: 0, 'awaiting-launch': 1, launched: 2, failed: 3, expired: 4 }
      rows.sort((a, b) => (rank[a.phase] - rank[b.phase]) || (a.windowEnd - b.windowEnd))
      /**
       * ⭐ Our own token goes FIRST, ahead of the sort, because it is the platform's token rather
       * than one entry among the launches. ⚠ It still honours a phase filter, so the Migrated tab
       * does not show it until it actually has migrated.
       */
      const family = familyRow(indexer, now)
      if (family && (!wanted || family.phase === wanted)) rows = [family, ...rows]
      // ⭐ The price rides along with the listing: every row's cap is shown in dollars, and one
      // price for the whole page means no two rows can be converted at different rates.
      return send(res, 200, { sales: rows, count: rows.length, solUsd: indexer.solUsd })
    }

    /**
     * One sale's deposit history — the price chart's data.
     *
     * Raw rows, deliberately: turning `price_after` into a market cap needs the curve constants,
     * and those live in `curve.mjs`, which the browser already imports. Doing the arithmetic here
     * as well would be a second implementation of the same formula, which is exactly how the two
     * drift apart.
     */
    const h = /^\/api\/sales\/([1-9A-HJ-NP-Za-km-z]{32,44})\/history$/.exec(url.pathname)
    if (h) {
      const row = indexer.store.get(h[1])
      if (!row?.refreshed) return send(res, 404, { error: 'unknown sale' })
      const deposits = indexer.store.deposits(h[1]).map((d) => ({
        signature: d.signature,
        blockTime: d.block_time,
        slot: d.slot,
        depositor: d.depositor,
        amount: d.amount,
        allocation: d.allocation,
        priceAfter: d.price_after,
      }))
      return send(res, 200, { sale: h[1], deposits, count: deposits.length })
    }

    const m = /^\/api\/sales\/([1-9A-HJ-NP-Za-km-z]{32,44})$/.exec(url.pathname)
    if (m) {
      const row = indexer.store.get(m[1])
      if (!row?.refreshed) return send(res, 404, { error: 'unknown sale' })
      if (!isGenuineSale({ quoteLabel: row.quote, quoteMint: row.quote_mint })) return send(res, 404, { error: 'not a USDC sale' })
      return send(res, 200, { ...view(row, now), solUsd: indexer.solUsd })
    }

    send(res, 404, { error: 'not found' })
  })

  return new Promise((resolve) => server.listen(port, HOST, () => resolve(server)))
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const indexer = await new Indexer().start()
  const server = await serve(indexer)
  console.log(`[indexer] ${indexer.opts.rpc} -> :${server.address().port}, ${indexer.store.addresses().length} sales known`)
  const bye = async () => { await indexer.stop(); server.close(); process.exit(0) }
  process.on('SIGINT', bye)
  process.on('SIGTERM', bye)
}
