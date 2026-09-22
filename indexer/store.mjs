/**
 * The indexer's disk state: which sales exist, and the last signature already walked.
 *
 * Deliberately small. This is a CACHE of addresses, not a ledger — every number served to a client
 * is re-read from the sale account on chain. If this file is deleted the service rebuilds it by
 * walking the program's signature history from genesis, and nothing is lost but the walk.
 */
import { DatabaseSync } from 'node:sqlite'

export function openStore(path) {
  const db = new DatabaseSync(path)
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS sales (
      address     TEXT PRIMARY KEY,
      mint        TEXT,
      name        TEXT,
      symbol      TEXT,
      uri         TEXT,
      authority   TEXT,
      -- pump.fun's creator argument, fixed at launch. The launch instruction needs it as an
      -- account, so the listing has to carry it or a launch button cannot build its transaction.
      -- NOTE: no backticks in this block - it lives inside a JS template literal.
      creator_fee_recipient TEXT,
      status      INTEGER,
      window_end   INTEGER,
      launch_deadline INTEGER,
      hard_cap    INTEGER,
      min_raise   INTEGER,
      per_wallet_cap INTEGER,
      -- What the sale is denominated in: 'sol' or 'usdc'. Every cap, the gross and every deposit
      -- amount on this row is in THAT quote's base units - nine decimals or six - so a listing
      -- that prints them without reading this column is off by a factor of a thousand.
      quote       TEXT,
      quote_mint  TEXT,
      gross       INTEGER,
      sold        INTEGER,
      depositors  INTEGER,
      first_seen  INTEGER NOT NULL,
      refreshed   INTEGER,
      missing     INTEGER NOT NULL DEFAULT 0,
      -- Resolved once from the sale's uri. Kept here so a listing of 200 sales is one response
      -- rather than 200 IPFS round trips from every visitor's browser.
      image       TEXT,
      description TEXT,
      twitter     TEXT,
      telegram    TEXT,
      website     TEXT,
      meta_state  TEXT,
      -- Where this coin's price comes from RIGHT NOW: null (never launched), 'curve' (live on
      -- pump.fun's bonding curve), 'migrated' (the curve is drained and it trades in an AMM pool),
      -- or 'unknown' (launched, but the read failed). ⛔ 'unknown' is not 'migrated' and neither is
      -- worth zero - see market.mjs.
      market_state TEXT,
      -- Market cap in the sale's OWN quote asset, or null when nothing could price it. Stored as a
      -- REAL: it is a derived display figure, not money, and it spans nine orders of magnitude.
      market_cap  REAL,
      -- The AMM pool a migrated coin trades in, cached once found so the indexes are not re-walked.
      pool        TEXT,
      market_at   INTEGER
    );
    CREATE INDEX IF NOT EXISTS sales_status ON sales(status, window_end);
    CREATE TABLE IF NOT EXISTS cursor (k TEXT PRIMARY KEY, v TEXT);
    -- One row per deposit, for the price chart. Keyed by SIGNATURE so re-walking history is
    -- idempotent: the same deposit seen twice updates its own row instead of drawing a second
    -- point. block_time is the CHAIN's clock, the only one the program agrees with.
    CREATE TABLE IF NOT EXISTS deposits (
      signature   TEXT PRIMARY KEY,
      sale        TEXT NOT NULL,
      block_time  INTEGER,
      slot        INTEGER,
      depositor   TEXT,
      amount      INTEGER,
      allocation  INTEGER,
      -- u128 virtual_sol after the deposit. TEXT because it does not fit an INTEGER column.
      price_after TEXT
    );
    CREATE INDEX IF NOT EXISTS deposits_sale ON deposits(sale, block_time);
  `)

  /**
   * Columns added after a database already existed.
   *
   * `CREATE TABLE IF NOT EXISTS` is a no-op against a table that is already there, so a column
   * added to the block above reaches a fresh database and no other. The service then throws
   * `no such column` while preparing its statements and never starts — on the operator's box,
   * where the file has been accumulating sales, not in the tests, which build a new one each run.
   *
   * Additive only, and each one tried on its own: a column that is already present is the normal
   * case, not a failure.
   */
  for (const [col, type] of [
    ['creator_fee_recipient', 'TEXT'],
    ['twitter', 'TEXT'],
    ['telegram', 'TEXT'],
    ['website', 'TEXT'],
    ['quote', 'TEXT'],
    ['quote_mint', 'TEXT'],
    ['market_state', 'TEXT'],
    ['market_cap', 'REAL'],
    ['pool', 'TEXT'],
    ['market_at', 'INTEGER'],
    // How many times the metadata fetch has been tried, and when it may be tried again.
    // ⛔⛔ These exist because 'failed' used to be FOREVER: one 429 from an IPFS gateway and a
    // perfectly good token lost its image on this site permanently. See `resolveMetadata`.
    ['meta_tries', 'INTEGER'],
    ['meta_next', 'INTEGER'],
    // Where this sale's creator fee goes: 1 = the coin's holders, 0 = the creator. Fixed at open
    // and applied at launch; pump.fun offers no way to change it for a coin afterwards.
    ['holder_rewards', 'INTEGER'],
    /**
     * ⛔ The raise in LAMPORTS, which is not derivable from `gross`.
     *
     * `gross` is the USDC buyers sent; these two are the SOL side. `sol_expected` is the
     * program's OWN running total of what each deposit bought at the pool's rate when it was
     * booked, and `sol_in` is what the swap at the close actually returned. Neither can be
     * recomputed later from `gross` — a spot rate applied now is a different number.
     *
     * They are stored because the sale page falls back to this row whenever the chain read
     * fails, and while they were missing that fallback hardcoded them to zero: a live sale
     * holding real money rendered "0.000 SOL" raised, confidently, on the degraded path.
     */
    ['sol_expected', 'INTEGER'],
    ['sol_in', 'INTEGER'],
    // The custom liquidity token a pair sale's coin launches against (`set_pair`), or null for an
    // ordinary SOL-paired sale. Written once: the program refuses to change it.
    ['pair_mint', 'TEXT'],
  ]) {
    try { db.exec(`ALTER TABLE sales ADD COLUMN ${col} ${type}`) } catch { /* already there */ }
  }

  const insert = db.prepare(
    `INSERT INTO sales (address, first_seen) VALUES (?, ?) ON CONFLICT(address) DO NOTHING`
  )
  const update = db.prepare(`
    UPDATE sales SET mint=?, name=?, symbol=?, uri=?, authority=?, creator_fee_recipient=?,
      status=?, window_end=?, launch_deadline=?, hard_cap=?, min_raise=?, per_wallet_cap=?,
      quote=?, quote_mint=?, gross=?, sold=?, depositors=?, holder_rewards=?,
      sol_expected=?, sol_in=?, refreshed=?, missing=0
    WHERE address=?`)
  const markMissing = db.prepare(`UPDATE sales SET missing=missing+1, refreshed=? WHERE address=?`)
  const allAddrs = db.prepare(`SELECT address FROM sales WHERE missing < 5`)
  const getCursor = db.prepare(`SELECT v FROM cursor WHERE k=?`)
  const setCursor = db.prepare(
    `INSERT INTO cursor (k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`
  )
  /**
   * ⛔⛔ `missing < 3`, not `missing = 0`.
   *
   * A sale is marked missing whenever one read comes back with no data — and an RPC that returned
   * null for an account that exists is a thing that happens under load. At `missing = 0` a single
   * such blip made a launched token DISAPPEAR from the front page and from Explore until the next
   * refresh, with nothing logged and `/api/health` still green.
   *
   * ⚠ The two thresholds are deliberately different and this is the ordering that makes sense:
   * keep SHOWING it while we still believe it exists (3), and keep RE-READING it a little longer
   * than that (`allAddrs`, 5). A sale account that is genuinely gone climbs past both and stops
   * being listed; one that dropped out for a moment comes straight back, because a successful read resets it to 0.
   */
  const list = db.prepare(`SELECT * FROM sales WHERE refreshed IS NOT NULL AND missing < 3`)
  // ⛔ `meta_state IS NULL` alone meant a row was attempted ONCE, ever. A row parked with
  // meta_state='retry' comes back when its backoff expires; 'ok' and 'failed' are settled.
  const needMeta = db.prepare(
    `SELECT address, uri, COALESCE(meta_tries, 0) AS tries FROM sales
      WHERE uri IS NOT NULL AND uri != ''
        AND (meta_state IS NULL OR (meta_state = 'retry' AND COALESCE(meta_next, 0) <= ?))
      LIMIT ?`)
  const putMeta = db.prepare(
    `UPDATE sales SET image=?, description=?, twitter=?, telegram=?, website=?, meta_state=?,
       meta_tries=COALESCE(meta_tries,0)+1, meta_next=? WHERE address=?`)
  const one = db.prepare(`SELECT * FROM sales WHERE address=?`)
  const putMkt = db.prepare(
    `UPDATE sales SET market_state=?, market_cap=?, pool=?, market_at=? WHERE address=?`)
  // Launched sales only: nothing else has a coin to price. `missing` is bounded for the same
  // reason the listing excludes it - a row nobody can read is not a row to spend RPC calls on.
  const launched = db.prepare(
    `SELECT address, mint, quote, quote_mint, pool, market_state FROM sales
     WHERE status=1 AND mint IS NOT NULL AND missing < 3`)
  const putDep = db.prepare(`
    INSERT INTO deposits (signature, sale, block_time, slot, depositor, amount, allocation, price_after)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(signature) DO UPDATE SET
      block_time=excluded.block_time, slot=excluded.slot, amount=excluded.amount,
      allocation=excluded.allocation, price_after=excluded.price_after`)
  const depsFor = db.prepare(
    `SELECT * FROM deposits WHERE sale=? ORDER BY block_time ASC, slot ASC`)
  // Just the price column, for the listing's sparkline. Newest 40 then reversed rather than the
  // oldest 40: a long sale's sparkline should show where it is now, not where it started.
  const sparkFor = db.prepare(
    `SELECT price_after FROM deposits WHERE sale=? ORDER BY block_time DESC, slot DESC LIMIT 40`)
  /**
   * Every sale's sparkline in ONE query.
   *
   * The listing calls this once per request, and the listing is polled every 15 seconds by every
   * open tab. Running the single-sale query per row made that N queries per poll, which is fine at
   * five sales and pointless work at five hundred. The window function does the per-sale limit
   * inside SQLite instead.
   */
  const allSparks = db.prepare(`
    SELECT sale, price_after FROM (
      SELECT sale, price_after,
             ROW_NUMBER() OVER (PARTITION BY sale ORDER BY block_time DESC, slot DESC) AS rn
      FROM deposits
    ) WHERE rn <= 40
    ORDER BY sale, rn DESC`)

  const setPairStmt = db.prepare(`UPDATE sales SET pair_mint=? WHERE address=?`)
  const pairOfStmt = db.prepare(`SELECT pair_mint FROM sales WHERE address=?`)
  return {
    db,
    setPair(address, mint) { setPairStmt.run(mint, address) },
    pairOf(address) { return pairOfStmt.get(address)?.pair_mint ?? null },
    /** True when this address had not been seen before. */
    add(address, now = Date.now()) {
      return insert.run(address, now).changes > 0
    },
    /** Writes back what the chain says. Numbers are stored as integers, so BigInts are narrowed. */
    put(address, s, now = Date.now()) {
      const n = (v) => (typeof v === 'bigint' ? Number(v) : v)
      update.run(
        s.mint.toBase58(), s.name, s.symbol, s.uri, s.authority.toBase58(),
        s.creatorFeeRecipient.toBase58(), s.status,
        n(s.windowEnd), n(s.launchDeadline), n(s.hardCap), n(s.minRaise), n(s.perWalletCap),
        s.quoteLabel ?? 'sol', s.quoteMint ? s.quoteMint.toBase58() : null,
        n(s.gross), n(s.sold), s.depositors,
        // ⛔ A number, not a bool: SQLite has no boolean, and `undefined` binds as null — which
        // would read back as "unknown" rather than "to the creator" on every pre-existing sale.
        s.holderRewards ? 1 : 0,
        n(s.solExpected ?? 0), n(s.solIn ?? 0),
        now, address
      )
    },
    /**
     * A sale account that did not come back. Counted rather than deleted: one bad RPC response
     * must not evict a real sale, and five in a row is a closed account rather than a blip.
     */
    miss(address, now = Date.now()) { markMissing.run(now, address) },
    addresses() { return allAddrs.all().map((r) => r.address) },
    all() { return list.all() },
    get(address) { return one.get(address) },
    /** Every launched sale, with what is known about where its price lives. */
    launched() { return launched.all() },
    /**
     * Records where a coin's price came from and what it was.
     *
     * ⛔ `cap` is null when nothing could price the coin, and that null is written as a null. An
     * unreadable pool must not land in the listing as a market cap of zero.
     */
    putMarket(address, { state, cap = null, pool = null }, now = Date.now()) {
      putMkt.run(state, cap, pool, now, address)
    },
    /** Sales whose off-chain metadata is unresolved, or parked for a retry that is now due. */
    pendingMetadata(limit = 20, now = Math.floor(Date.now() / 1000)) { return needMeta.all(now, limit) },
    /**
     * `state` is 'ok', 'failed' (settled — never tried again) or 'retry' (try after `nextAt`).
     *
     * ⛔⛔ The distinction is the whole point. Everything that was not a 200 used to be recorded
     * as 'failed', and 'failed' was FOREVER: one 429 from an IPFS gateway, or one timeout during
     * a sweep, and a perfectly good token showed no image on this site for the rest of its life.
     * Only a definite answer — a 404, or a document that is not the metadata — is settled.
     */
    putMetadata(address, { image = null, description = null, twitter = null, telegram = null, website = null }, state, nextAt = null) {
      putMeta.run(image, description, twitter, telegram, website, state, nextAt, address)
    },
    /** Idempotent by signature, so a re-walk cannot double-count a deposit. */
    putDeposit(signature, d, blockTime, slot) {
      const n = (v) => (typeof v === 'bigint' ? Number(v) : v)
      putDep.run(signature, d.sale, blockTime ?? null, slot ?? null, d.depositor,
                 n(d.amount), n(d.allocation), String(d.priceAfter))
    },
    deposits(sale) { return depsFor.all(sale) },
    spark(sale) { return sparkFor.all(sale).map((r) => r.price_after).reverse() },
    /** `{ [saleAddress]: [price, ...] }`, oldest first, for the whole listing at once. */
    sparks() {
      const out = Object.create(null)
      for (const r of allSparks.all()) (out[r.sale] ??= []).push(r.price_after)
      return out
    },
    cursor(k) { return getCursor.get(k)?.v ?? null },
    setCursor(k, v) { setCursor.run(k, v) },
    close() { db.close() },
  }
}
