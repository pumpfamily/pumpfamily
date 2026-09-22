/**
 * The pieces both the listing and the sale page render a coin with.
 *
 * Shared rather than duplicated for the same reason `curve.mjs` is symlinked into the browser: two
 * copies of "what phase is this sale in" would eventually disagree, and the one place that would
 * show up is a listing that says a window is open next to a page that says it is closed.
 */
import { useEffect, useState } from 'react'
import { fmtUsdCap, usdMarketCap } from './curve.mjs'

/** The program's phases, named the way a buyer would describe them. */
export const PHASE_LABEL = {
  open: 'open',
  'awaiting-launch': 'launching',
  launched: 'launched',
  migrated: 'migrated',
  failed: 'refunded',
  failing: 'refunding',
  expired: 'expired',
}

export const PHASE_TONE = {
  open: 'live',
  'awaiting-launch': 'warn',
  launched: 'done',
  // Its own tone: a migrated coin is the good end state, not a finished sale.
  migrated: 'live',
  failed: 'dead',
  failing: 'warn',
  expired: 'dead',
}

/**
 * Derives a sale's phase from its own numbers.
 *
 * ⚠ `now` must be the CHAIN's clock. Every deadline here was written by the program from
 * `Clock::unix_timestamp`, which tracks slots rather than wall time — see `clockSkew` in chain.js.
 *
 * `status` alone is not the phase: a sale stays `Open` on chain from creation until someone
 * launches it, so a UI keyed on `status` keeps offering deposits after the window has shut.
 */
export function phaseOf({ status, windowEnd, launchDeadline, gross, minRaise, marketState }, now) {
  // ⛔ Migration is invisible to this program — a graduated coin is still `Launched` on chain. Only
  // the indexer can see it (it reads pump.fun's curve), so it arrives as `marketState` on a listing
  // row and is absent when this is called on an account read. Handled HERE rather than in the
  // listing so every page agrees: the launchpad and the portfolio must not label one coin two ways.
  if (status === 1 && marketState === 'migrated') return 'migrated'
  if (status === 1) return 'launched'
  if (status === 2) return 'failed'
  if (now < Number(windowEnd)) return 'open'
  // A closed window that missed its minimum is about to refund, not launch.
  if (gross !== undefined && minRaise !== undefined && Number(gross) < Number(minRaise)) return 'failing'
  if (now < Number(launchDeadline)) return 'awaiting-launch'
  return 'expired'
}

/**
 * The coin's image, falling back to the first letter of its ticker.
 *
 * The URL comes from metadata whoever opened the sale supplied, so it is treated as untrusted: it
 * is only ever an `<img src>`, never fetched or parsed here, and one that fails to load collapses
 * to the monogram rather than a broken-image icon.
 */
export function Avatar({ image, symbol, size }) {
  // The URL that failed, not a boolean: a boolean has to be reset when `image` changes, and doing
  // that in an effect costs a second render on every row. Comparing URLs needs no reset at all.
  const [failedUrl, setFailedUrl] = useState(null)
  const style = size ? { width: size, height: size } : undefined
  if (image && failedUrl !== image) {
    return <img className="tok-img" style={style} src={image} alt="" loading="lazy"
                onError={() => setFailedUrl(image)} />
  }
  return <div className="tok-img mono" style={style} aria-hidden="true">{(symbol || '?').slice(0, 1)}</div>
}

/**
 * A coin's links, as the creator supplied them.
 *
 * ⚠ These are attacker-controlled strings that become hrefs. The indexer already drops anything
 * that is not plainly `http(s)://`, and this checks again rather than trusting that — a listing is
 * exactly where a `javascript:` URL would be most useful to someone. `rel="noopener noreferrer"`
 * and `target="_blank"` keep the opened page away from this one.
 */
export function Socials({ twitter, telegram, website, onClick }) {
  const links = [
    ['X', twitter], ['TG', telegram], ['WWW', website],
  ].filter(([, href]) => typeof href === 'string' && /^https?:\/\//.test(href))
  if (!links.length) return null
  return (
    <span className="socials">
      {links.map(([label, href]) => (
        <a key={label} href={href} target="_blank" rel="noopener noreferrer"
           onClick={onClick} title={href}>{label}</a>
      ))}
    </span>
  )
}

/** Compact duration. Reads as a deadline rather than a stopwatch above an hour. */
export function countdown(seconds) {
  if (seconds <= 0) return 'closed'
  const d = Math.floor(seconds / 86400)
  const h = Math.floor(seconds / 3600) % 24
  const m = Math.floor(seconds / 60) % 60
  const s = Math.floor(seconds) % 60
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m ${s}s`
}

/** Already reads as a phrase — callers must not append "ago". */
export function age(seconds) {
  if (seconds < 60) return 'just now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`
  return `${Math.floor(seconds / 86400)}d ago`
}

const EMPTY_META = { image: null, description: null, twitter: null, telegram: null, website: null }

/**
 * Resolves one sale's metadata in the browser.
 *
 * The listing gets this from the indexer, which resolves it once for everyone. A sale page cannot
 * rely on that: it is the surface people reach by shared link, and it has to work with the indexer
 * down. One fetch for one coin is cheap, where two hundred would not be.
 *
 * Applies the same rule the indexer does — only `http(s)://` strings survive, at a bounded length —
 * because these end up as hrefs and the document is written by whoever opened the sale.
 */
export function useTokenMeta(uri) {
  const [meta, setMeta] = useState(EMPTY_META)
  useEffect(() => {
    if (!uri) { setMeta(EMPTY_META); return }
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch(uri, { redirect: 'follow', signal: AbortSignal.timeout(8000) })
        if (!res.ok) return
        const doc = await res.json()
        if (cancelled) return
        const url = (v, max = 400) =>
          typeof v === 'string' && /^https?:\/\//.test(v) ? v.slice(0, max) : null
        setMeta({
          image: url(doc.image),
          description: typeof doc.description === 'string' ? doc.description.slice(0, 500) : null,
          twitter: url(doc.twitter, 200),
          telegram: url(doc.telegram, 200),
          website: url(doc.website, 200),
        })
      } catch { /* a coin with no reachable metadata still has to render */ }
    })()
    return () => { cancelled = true }
  }, [uri])
  return meta
}

/**
 * A contract address, shown in full, that copies itself when clicked.
 *
 * ⛔ In FULL. Truncating a contract address makes it useless for the one thing anyone wants from
 * it, and a separate `copy` control beside it is a second target for the same intent.
 *
 * ⚠ A real `<button>`, not a div with a click handler, so it is reachable by keyboard and
 * announced as a control. The confirmation sits beside the address rather than replacing it —
 * what you came to read stays on screen while you are told it was copied.
 *
 * ⚠ Clipboard access is refused outright in some browsers and over plain http, so a failure is
 * SAID. A button that visibly did nothing reads as broken.
 */
export function CopyableAddress({ value, className = '' }) {
  const [state, setState] = useState(null)
  if (!value) return null
  return (
    <button className={`ca-btn mono ${className}`.trim()} title="Click to copy"
            aria-label={`Copy the contract address ${value}`}
            onClick={async () => {
              try { await navigator.clipboard.writeText(value); setState('ok') }
              catch { setState('no') }
              setTimeout(() => setState(null), 1600)
            }}>
      {value}
      <span className={`ca-copied${state ? ' on' : ''}`} aria-live="polite">
        {state === 'no' ? 'copy failed' : 'copied'}
      </span>
    </button>
  )
}

/**
 * One coin, as a card. The single way a coin is shown in a grid — Explore, the home page's latest
 * launches, and My tokens.
 *
 * ⛔⛔ Ticker, name, market cap. Nothing else. It used to be a table row carrying a raise figure,
 * a progress bar, a status pill, a countdown and a buy prompt, five things competing for a glance
 * that is deciding one question: is this coin worth opening? The market cap is what answers it.
 *
 * ⚠ `marketCap` is in the CURVE's asset (SOL) and `solUsd` converts it. Without a price the cap
 * is shown as a dash — a coin nobody can price is not a coin worth zero (see market.mjs).
 */
export function TokenCard({ sale, solUsd }) {
  const featured = sale.featured === true
  const usd = sale.marketCap != null && solUsd
    ? fmtUsdCap(usdMarketCap(sale.marketCap, solUsd))
    : null
  return (
    <a className="lc" href={featured ? `/token/${sale.mint}` : `/sale/${sale.address}`}>
      <div className="lc-img">
        {sale.image
          ? <img src={sale.image} alt="" loading="lazy" onError={(e) => { e.currentTarget.style.display = 'none' }} />
          : null}
        <span className="lc-mono">{(sale.symbol || '?').slice(0, 2)}</span>
      </div>
      <div className="lc-body">
        <span className="lc-tick mono">${sale.symbol || '—'}</span>
        <strong className="lc-name">{sale.name || 'Unnamed'}</strong>
        <div className="lc-cap"><b>{usd ?? '—'}</b><span>MC</span></div>
      </div>
    </a>
  )
}

/** The grid those cards sit in. One place, so every listing wraps and spaces identically. */
export function TokenGrid({ rows, solUsd = null }) {
  return (
    <div className="lc-grid">
      {rows.map((s) => <TokenCard key={s.address} sale={s} solUsd={solUsd} />)}
    </div>
  )
}
