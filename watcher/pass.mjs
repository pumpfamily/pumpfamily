/**
 * One pass of the watcher over the indexer's sale list, at a cost that does not grow with the
 * launchpad's history.
 *
 * 🔴🔴 Before this the watcher gave every sale the FULL treatment every 15 seconds — the deposit
 * account's whole signature history, a receipt read per transfer, the sale account three times,
 * the chain clock twice, every position — whether the sale closed a minute ago or a month ago.
 * With 122 finished sales and 4 open ones that was ~1,500 RPC calls a pass against a key rated
 * for 10 a second: the key answered 429 to 1,800 calls in half an hour, `attest failed` on real
 * open sales among them, and a pass took minutes. A buyer's money sat in the vault while the
 * watcher re-read history nobody had touched.
 *
 * Two tiers, and the INDEXER's status only ever decides the tier, never whether a sale is worked:
 *
 *  - **Open** (status 0 in the listing): the full treatment, every pass, first. A sale in its
 *    window is the whole product.
 *  - **Settled** (status 1 launched / 2 failed): checked in a rotating slice, so each finished
 *    sale comes round every `every` passes (~5 minutes at the default 15s × 20) and no pass
 *    stalls on all of them at once. A settled sale is read twice, cheaply — its account and its
 *    deposit balance — and gets the full treatment only when that fingerprint has changed since a
 *    full pass last found NOTHING left to do. A late send changes the balance; an undelivered
 *    position, a pending return, an unclosed credit or any error keeps the sale out of `quiet`.
 *
 * ⛔ Which direction can the listing be wrong in? Status only ever moves 0 → 1|2 on chain, so a
 * stale listing can call an open sale settled for at most one refresh — and the settled path
 * reads the chain first and hands a status-0 sale straight back to the full treatment. The
 * other way round (listing says open, chain says settled) merely costs a full pass.
 *
 * ⛔ `quiet` lives in memory. A restart forgets it, and every settled sale gets one full pass
 * again, spread over the first `every` passes. That is the safe direction.
 */

export const SETTLED_EVERY = Number(process.env.SETTLED_EVERY ?? 20)

/** A stable slot for an address, so a sale's turn does not move when the list is reordered. */
export const bucketOf = (address, every) => {
  let h = 0
  for (const c of String(address)) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return h % every
}

/**
 * Which rows this pass works, in order.
 *
 * ⛔ The listing carries one row that is NOT a sale: the platform's own token, keyed by its mint
 * and with no `authority`. The watcher used to treat it as a sale and fail on it — twice — every
 * pass, forever ("offset is out of range … <= 391": a mint account decoded as a sale).
 */
export function planPass(rows, pass, every = SETTLED_EVERY) {
  const sales = (rows ?? []).filter((r) => r?.address && r?.authority)
  return {
    open: sales.filter((r) => r.status === 0),
    settled: sales.filter((r) => r.status !== 0 && bucketOf(r.address, every) === ((pass % every) + every) % every),
    notSales: (rows ?? []).length - sales.length,
  }
}

/**
 * Does a full pass leave nothing behind? Only then may a settled sale go quiet.
 *
 * `attest` / `crank` are the results of `attestSale` / `crankSale`, or `null` if that half threw.
 */
export const nothingLeft = (attest, crank) =>
  !!attest && !!crank
  && !attest.credited?.length && !attest.returned?.length && !attest.closePending && !attest.closed && !(attest.waiting > 0)
  && !crank.launched && !crank.failed && !crank.swapped && !crank.delivered && crank.complete === true

/**
 * Runs one pass.
 *
 *   readSale(address)      → decoded sale, or null when the chain holds no genuine sale there
 *   readHeld(deposit)      → the deposit account's balance, as a string of base units
 *   attest(address), crank(address) → the two halves, each may throw
 *   quiet: Map<address, fingerprint>, owned by the caller, carried between passes
 */
export async function passOver(rows, pass, quiet, { readSale, readHeld, attest, crank, log = () => {}, every = SETTLED_EVERY }) {
  const { open, settled, notSales } = planPass(rows, pass, every)
  const tally = { open: open.length, settled: settled.length, full: 0, quiet: 0, notSales }

  const full = async (r) => {
    tally.full++
    // Attesting and cranking fail independently: a sale stuck on one transfer must still launch,
    // fail or deliver whatever it already can.
    let a = null, c = null
    try { a = await attest(r.address) } catch (e) { log(r.address, `attest failed, retrying next round: ${e.message}`) }
    try { c = await crank(r.address) } catch (e) { log(r.address, `crank failed, retrying next round: ${e.message}`) }
    return { a, c }
  }

  for (const r of open) await full(r)

  for (const r of settled) {
    let fp = null
    try {
      const s = await readSale(r.address)
      if (!s) continue
      // Open on chain: the full treatment, and no memory of it as settled (there cannot be one —
      // status never moves back to 0 — but a stale entry must never be able to skip a real pass).
      if (s.status === 0) { quiet.delete(r.address); await full(r); continue }
      fp = `${s.status}:${await readHeld(s.depositAccount)}`
      if (quiet.get(r.address) === fp) { tally.quiet++; continue }
    } catch (e) {
      // Unreadable is not quiet: a fingerprint that could not be read decides nothing.
      log(r.address, `settled check unreadable, doing the full pass: ${e.message}`)
      fp = null
    }
    const { a, c } = await full(r)
    if (fp && nothingLeft(a, c)) quiet.set(r.address, fp)
    else quiet.delete(r.address)
  }
  return tally
}
