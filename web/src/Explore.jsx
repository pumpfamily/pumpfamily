/**
 * The launchpad itself: every sale, browsable.
 *
 * Reads the indexer rather than the chain. `getProgramAccounts` is 403-blocked on the operator's
 * RPC plan, so there is no way for a browser to enumerate sale accounts directly — see
 * `indexer/indexer.mjs`. That makes the indexer a hard dependency of this page and of nothing
 * else, which is why its absence is rendered as an explained state rather than an empty list: an
 * empty launchpad and an unreachable service look identical otherwise, and only one of them is
 * worth waking someone up for.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { TokenGrid } from './token.jsx'
import { marketCapFromSold } from './Chart.jsx'

/**
 * A sale is denominated in SOL or USDC, and the listing shows both side by side — so a row's
 * figures are converted at that row's own scale and labelled with its own unit. Nine decimals
 * against six: the same integer means a thousandfold different amount.
 */
/** Sorting key: an unpriceable coin goes last instead of pretending to be worth nothing. */
/**
 * A row's market cap, in its own quote asset — or `null` when nothing can price it.
 *
 * ⛔ THREE different accounts price a coin over its life and only one of them is right at a time:
 * the shadow curve while the window is open, pump.fun's bonding curve once it has launched, and an
 * AMM pool once it has migrated. The indexer reads the two on-chain ones and serves `marketCap`;
 * the browser derives only the presale figure, which needs no RPC.
 *
 * ⛔ A launched coin whose cap could not be read is `null`, NOT 0. A migrated coin's curve reads
 * all zeroes, so "price it from the curve anyway" renders a live coin as worthless.
 */
export function capOf(sale) {
  if (sale.marketCap !== null && sale.marketCap !== undefined) return sale.marketCap
  // Never launched: the shadow curve is the only thing that has ever priced it, and it is exact.
  if (sale.phase === 'open' || sale.phase === 'awaiting-launch' || sale.phase === 'failing') {
    // ⛔ 'sol', not the sale's quote. What buyers SEND is USDC; what the coin trades on is
    // pump.fun's SOL curve, and a market cap is a fact about the coin.
    return marketCapFromSold(sale.sold, 'sol')
  }
  return null
}
const capRank = (sale) => { const c = capOf(sale); return c === null ? -Infinity : c }

/**
 * Where the indexer lives.
 *
 * In production it is behind the site's own Caddy vhost at `/api/*`, so the right value is the
 * empty string and every fetch is same-origin — which also means no CORS and no second hostname
 * to keep a certificate on. `??` rather than `||` on purpose: an empty string IS the production
 * answer, and `||` would treat it as unset and send the built site to localhost.
 */
export const INDEXER_URL = import.meta.env.VITE_INDEXER_URL ?? (import.meta.env.DEV ? 'http://localhost:5241' : '')

/**
 * ⛔ `phase` filters the listing; `null` means every launch, whatever state it is in.
 *
 * "Migrated" is the one that needs care: a coin that graduates off pump.fun's bonding curve is
 * still `launched` to our program, and its curve then reads all zeroes. The indexer marks it, and
 * this tab shows only those — see `market.mjs`.
 */
const TABS = [
  { key: 'all', label: 'All', phase: null },
  { key: 'new', label: 'New', phase: null },
  { key: 'closing', label: 'Closing soon', phase: 'open' },
  { key: 'migrated', label: 'Migrated', phase: 'migrated' },
]

/** Ticks once a second off the local clock, anchored to the chain's — see chain.js. */
function useTick() {
  const [, setN] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setN((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [])
}

/* ⛔ `SaleTable` and its `Row` lived here until 21 Sep 2026. Every listing — Explore, the home
   page and My tokens — now renders `TokenGrid` from token.jsx, so a coin looks the same wherever
   it appears and there is one place to change it. The table is in git if it is ever wanted back. */


export default function Explore({ undeployed = false }) {
  const [tab, setTab] = useState('all')
  const [q, setQ] = useState('')
  const [data, setData] = useState({ state: 'loading', sales: [], solUsd: null })
  const searchRef = useRef(null)

  // The "/" chip in the search box promises a shortcut, so the shortcut exists. Ignored while
  // the caret is already in a field, or typing a slash into any input would steal focus.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return
      const t = e.target
      if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t?.isContentEditable) return
      e.preventDefault()
      searchRef.current?.focus()
    }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey) }
  }, [])
  useTick()

  const load = useCallback(async () => {
    try {
      // ⚠ /api/stats went with the header strip this page used to carry. One fewer request.
      const [salesRes, healthRes] = await Promise.all([
        fetch(`${INDEXER_URL}/api/sales`),
        fetch(`${INDEXER_URL}/api/health`),
      ])
      if (!salesRes.ok) throw new Error(`the indexer returned HTTP ${salesRes.status}`)
      const sales = await salesRes.json()
      const health = await healthRes.json()
      setData({ state: 'ok', sales: sales.sales ?? [], chainTime: health.chainTime, solUsd: sales.solUsd ?? null })
    } catch (e) {
      setData({ state: 'offline', sales: [], error: e.message })
    }
  }, [])

  useEffect(() => {
    load()
    const t = setInterval(load, 15_000)
    return () => clearInterval(t)
  }, [load])


  const rows = useMemo(() => {
    const active = TABS.find((t) => t.key === tab) ?? TABS[0]
    let out = data.sales
    if (active.phase) out = out.filter((s) => s.phase === active.phase)
    const needle = q.trim().toLowerCase()
    if (needle) {
      out = out.filter((s) =>
        (s.symbol || '').toLowerCase().includes(needle) ||
        (s.name || '').toLowerCase().includes(needle) ||
        (s.address || '').toLowerCase().includes(needle) ||
        (s.mint || '').toLowerCase().includes(needle))
    }
    const sorted = [...out]
    // ⛔ Market cap, not "raised": they are different numbers and only one of them still moves
    // after a coin launches. A sale with no readable cap sorts last rather than as a zero.
    if (tab === 'all' || tab === 'migrated') sorted.sort((a, b) => capRank(b) - capRank(a))
    else if (tab === 'closing') sorted.sort((a, b) => a.windowEnd - b.windowEnd)
    else sorted.sort((a, b) => b.firstSeen - a.firstSeen)
    return sorted
  }, [data.sales, tab, q])

  return (
    <section className="explore">
      <div className="explore-head center">
        <h1>Every token launched</h1>
        <p className="lede">
          Every token launched through Pump Family
        </p>
      </div>

      <div className="explore-controls center">
        <div className="search">
          <input className="field" ref={searchRef} value={q} onChange={(e) => setQ(e.target.value)}
                 placeholder="Search name, ticker or address" aria-label="Search launches" />
          {!q && <span className="kbd" aria-hidden="true">/</span>}
        </div>
      </div>

      <div className="tabs pills explore-tabs center">
        {TABS.map((t) => (
          <button key={t.key} className={tab === t.key ? 'on' : ''} onClick={() => setTab(t.key)}>
            {t.label}
          </button>
        ))}
      </div>

      {data.state === 'offline' ? (
        // Distinguished from "no launches yet" on purpose — see the note at the top of this file.
        <div className="empty">
          <h3>The launch index is not reachable</h3>
          <p>
            This page lists sales from the indexer at <span className="mono">{INDEXER_URL}</span>, because
            a browser cannot enumerate them from the chain directly — the RPC method for it is blocked
            on this plan.
          </p>
          <p className="mono dim">{data.error}</p>
          <p>
            Start it with <span className="mono">cd indexer &amp;&amp; npm start</span>, or open a sale
            directly by address on the <a href="/explore">Sale</a> tab.
          </p>
        </div>
      ) : data.state === 'loading' ? (
        <div className="empty"><p className="dim">Reading the index…</p></div>
      ) : rows.length === 0 ? (
        <div className="empty">
          <h3>{q ? 'Nothing matches that' : 'No launches here yet'}</h3>
          <p>
            {q
              ? 'Try a ticker, a name, or a sale address.'
              // ⛔ The invitation is conditional. Offering "open a sale" on a cluster the program
              // is not on sends the visitor into a flow that grinds a mint, uploads metadata and
              // asks for a signature, for a transaction that cannot land.
              : undeployed
                ? <>The index is reachable and holds nothing, which is accurate. Opening a sale is
                   turned off here — see the note above.</>
                : <>Be the first one to <a href="/create">launch a token</a>.</>}
          </p>
        </div>
      ) : (
        <TokenGrid rows={rows} solUsd={data.solUsd} />
      )}
    </section>
  )
}
