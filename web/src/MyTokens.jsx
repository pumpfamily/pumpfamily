/**
 * The coins this wallet launched.
 *
 * A creator's own view: every sale opened from the connected wallet, in the same table the
 * launchpad lists everyone else's in — deliberately the same component, because a creator
 * checking on their coin and a stranger browsing it must not be shown two different stories.
 *
 * ⭐ Nothing is searched for on chain. A sale records its `authority`, the indexer serves it, and
 * this filters the listing it already fetches. `getProgramAccounts` is blocked on this endpoint and
 * would be the only alternative.
 *
 * ⚠ The wallet that LAUNCHES is not the wallet that BUYS. Buys come from the FOMO app, whose
 * wallet cannot connect here — those live on `/portfolio`, which looks up any address. This page
 * is the other half: what you created, not what you hold.
 */
import { useCallback, useEffect, useState } from 'react'
import { INDEXER_URL, capOf } from './Explore.jsx'
import { TokenGrid } from './token.jsx'

const fmt = (n, d = 0) => Number(n).toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d })

export default function MyTokens({ wallet }) {
  const [data, setData] = useState({ state: 'loading', sales: [], chainTime: null })

  const load = useCallback(async () => {
    if (!wallet.publicKey) { setData({ state: 'nowallet', sales: [], chainTime: null }); return }
    try {
      const [salesRes, healthRes] = await Promise.all([
        fetch(`${INDEXER_URL}/api/sales`),
        fetch(`${INDEXER_URL}/api/health`),
      ])
      if (!salesRes.ok) throw new Error(`the indexer returned HTTP ${salesRes.status}`)
      const { sales = [], solUsd = null } = await salesRes.json()
      const health = await healthRes.json()
      setData({
        state: 'ok',
        sales: sales.filter((s) => s.authority === wallet.publicKey),
        chainTime: health.chainTime,
        solUsd,
      })
    } catch (e) {
      // ⛔ An unreachable index is said out loud. "You have launched nothing" is a different
      // statement, and a creator who has launched something would act on it.
      setData({ state: 'offline', sales: [], error: e.message })
    }
  }, [wallet.publicKey])

  useEffect(() => {
    load()
    const t = setInterval(load, 15_000)
    return () => clearInterval(t)
  }, [load])

  /* ⛔⛔ There was a `const chainNow = data.chainTime ? … : …` here, and a regex ate only its
     first line on 21 Sep. What survived was `const [mountedAt] = useState(…) ? … : …`, which
     reads `mountedAt` inside its own initialiser: a temporal dead zone. The build stayed green,
     oxlint stayed quiet, and the page threw `Cannot access 'i' before initialization` and
     rendered NOTHING. It is gone rather than repaired — every row arrives with its `phase`
     already decided by the indexer, so this component needs no clock of its own.
     ⚠ Second time this exact wreckage shipped; the first was Sale.jsx. A build passing is not
     a page rendering. */

  // Highest market cap first, the same ordering the launchpad's All tab uses.
  const rows = [...data.sales].sort((a, b) => {
    const x = capOf(a), y = capOf(b)
    return (y === null ? -Infinity : y) - (x === null ? -Infinity : x)
  })
  const launched = rows.filter((s) => s.phase === 'launched' || s.phase === 'migrated').length

  return (
    <section className="explore">
      <div className="explore-head center">
        <h1>My tokens</h1>
        <p className="lede">
          Every coin launched from this wallet. Coins you bought through FOMO are under{' '}
          <a href="/portfolio">your positions</a> instead.
        </p>
      </div>

      {data.state === 'nowallet' ? (
        <div className="empty">
          <h3>Connect a wallet</h3>
          <p>This page reads the launches opened by the connected wallet.</p>
        </div>
      ) : data.state === 'offline' ? (
        <div className="empty">
          <h3>The launch index is not reachable</h3>
          <p className="mono dim">{data.error}</p>
          <p>Your coins are unaffected — this page cannot list them until the index answers.</p>
        </div>
      ) : data.state === 'loading' ? (
        <div className="empty"><p className="dim">Reading your launches…</p></div>
      ) : rows.length === 0 ? (
        <div className="empty">
          <h3>Nothing launched from this wallet yet</h3>
          <p>Be the first one to <a href="/create">launch a token</a>.</p>
        </div>
      ) : (
        <>
          <div className="legend" style={{ marginBottom: 14 }}>
            <span>{fmt(rows.length)} {rows.length === 1 ? 'launch' : 'launches'}</span>
            <span className="flat">{fmt(launched)} live on pump.fun</span>
          </div>
          <TokenGrid rows={rows} solUsd={data.solUsd} />
        </>
      )}
    </section>
  )
}
