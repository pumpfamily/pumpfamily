/**
 * Says when the attester is running out of money, somewhere a person will actually see.
 *
 * ## ⛔⛔ Why this exists
 *
 * The attester pays for EVERYTHING the watcher does: a position's rent the first time a wallet
 * buys (~0.0016 SOL), a receipt per credit and per return (~0.0009), and a buyer's token account
 * at delivery (~0.002). Roughly **0.0045 SOL per buyer**. At 0.3 SOL that is about 65 buyers.
 *
 * Run dry mid-delivery and the failure is the quiet kind: buyers who paid are simply not sent
 * their tokens. Nothing reverts, nothing is lost, and the site reports itself healthy — the
 * watcher just retries forever against a wallet with no SOL. Until 21 Sep 2026 the only signal
 * was a line in journald that nobody reads.
 *
 * ## What it does
 *
 * Posts to `ALERT_WEBHOOK` — the same variable and the same shape `charity-remit` already uses, so
 * one URL turns alerting on for both. Discord, Slack and anything else taking a JSON POST work.
 *
 * ⚠ **Entirely optional and entirely non-fatal.** With no webhook set this is a no-op that still
 * logs. A webhook that fails, times out or returns 500 must never take the watcher down with it:
 * the alert is the least important thing this process does.
 *
 * ⛔ Rate limited. The watcher loops every 15 seconds; an unthrottled alert would be 5,760 messages
 * a day and would be muted within the hour, which is worse than no alert at all.
 */

/** Under this, the attester is close enough to empty to be worth waking someone. */
export const LOW_LAMPORTS = Number(process.env.ATTESTER_LOW_LAMPORTS ?? 50_000_000)   // 0.05 SOL

/** Roughly what one buyer costs the attester: position rent + receipts + a token account. */
export const LAMPORTS_PER_BUYER = 4_500_000

/** ⚠ Once an hour at most, per distinct message. Repeating is the point; spamming is not. */
const REPEAT_MS = Number(process.env.ALERT_REPEAT_MS ?? 3_600_000)
const lastSent = new Map()

/**
 * Sends one alert, at most once per `REPEAT_MS` for the same `key`.
 *
 * Returns what happened, so a caller can log it without having to know any of this. Never throws.
 */
export async function alert(key, text, { now = Date.now(), fetchImpl = fetch } = {}) {
  const hook = (process.env.ALERT_WEBHOOK ?? '').trim()
  if (!hook) return { sent: false, why: 'no ALERT_WEBHOOK set' }
  const last = lastSent.get(key)
  if (last !== undefined && now - last < REPEAT_MS) return { sent: false, why: 'rate limited' }
  lastSent.set(key, now)
  try {
    // ⚠ `content` is Discord's field and Slack's `text` is not it, so both are sent. A receiver
    // that wants neither gets a JSON body it can read anyway.
    const res = await fetchImpl(hook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: text, text }),
      signal: AbortSignal.timeout(8000),
    })
    return { sent: res.ok, why: res.ok ? 'sent' : `webhook returned ${res.status}` }
  } catch (e) {
    return { sent: false, why: `webhook failed: ${String(e).slice(0, 80)}` }
  }
}

/**
 * The attester's balance, as a line worth reading.
 *
 * ⛔ Returns `null` when the balance could not be READ. That is not "low" — an RPC that refused a
 * call is not evidence about a wallet, and alerting on it would train the reader to ignore this.
 */
export function attesterStatus(lamports, address) {
  if (lamports === null || lamports === undefined) return null
  const sol = lamports / 1e9
  const buyers = Math.floor(lamports / LAMPORTS_PER_BUYER)
  return {
    lamports, sol, buyers,
    low: lamports < LOW_LAMPORTS,
    text: `⚠ pump.family attester is LOW: ${sol.toFixed(4)} SOL on ${address} — about ${buyers} more buyer(s) before deliveries start failing. Top it up.`,
  }
}
