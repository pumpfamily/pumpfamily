/**
 * Paces a web3.js `Connection` so it never exceeds a request rate — in-process, ahead of the
 * provider's own limit, instead of learning it from 429s.
 *
 * 🔴 Measured on the production key, 22 Sep 2026: 10 concurrent requests all answer 200, 20
 * answer 14 × 429. The indexer's refresh chain fires ~45 sequential calls as fast as latency
 * allows (a ~20/s burst for two seconds every twenty), and the watcher's per-sale sequence does
 * the same in smaller bursts; both share the key. The AVERAGE was well under the limit and the
 * key still refused 150 calls every five minutes, each one a retry, a delay, and sometimes a
 * failed attest on a live sale. A burst limit is exceeded by bursts, not by averages.
 *
 * `pacing(rps)` is a `fetchMiddleware`: every request waits its turn so that no two leave less
 * than `1000 / rps` ms apart. With two processes on one key, give them rates that SUM to under
 * the limit (the services use RPC_RPS: watcher 5, indexer 4, against a limit of ~10).
 *
 * ⚠ Only the HTTP calls this Connection makes go through here — the websocket subscription and
 * any second Connection do not.
 */
export function pacing(rps) {
  const gap = 1000 / rps
  let next = 0
  return (info, init, fetch) => {
    const now = Date.now()
    const at = Math.max(now, next)
    next = at + gap
    const wait = at - now
    if (wait <= 0) fetch(info, init)
    else setTimeout(() => fetch(info, init), wait)
  }
}

/** The rate a service was told to keep, or a default. `0` or an unparsable value means unpaced. */
export const rpsFromEnv = (fallback) => {
  const v = Number(process.env.RPC_RPS ?? fallback)
  return Number.isFinite(v) && v > 0 ? v : 0
}

/** Options for `new Connection(url, …)` that pace it, or nothing when the rate is 0. */
export const pacedOptions = (rps, extra = {}) => (rps > 0 ? { ...extra, fetchMiddleware: pacing(rps) } : extra)
