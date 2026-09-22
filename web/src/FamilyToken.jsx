/**
 * Pump Family's own token.
 *
 * ## ⛔⛔ Why this is not the sale page
 *
 * FAMILY is launched on another platform, so there is no `Sale` account, no window, no deposit
 * address and no position. `/sale/<addr>` would read the chain, find nothing, and say "No sale at
 * that address" — which is true and useless. This page shows what the coin actually has: an
 * address, a market, and a place to trade it.
 *
 * ⚠ Name, ticker and logo come from THIS site rather than from the platform the coin was launched
 * on. If that platform's metadata moves or rots, our own token still renders correctly.
 *
 * ⛔⛔ Named `FamilyToken`, not `Token`: macOS's filesystem is case-insensitive, so a file called
 * `Token.jsx` IS `token.jsx` — the module every page imports `Avatar`, `Socials` and the phase
 * labels from. Writing one destroys the other, silently, and the build only fails later and
 * somewhere else.
 *
 * ⛔ Nothing here invents a window. It does not say "sold out", does not draw a curve it never
 * had, and shows no market cap at all when none can be read — a coin nobody can price is not a
 * coin worth zero.
 */
import { useCallback, useEffect, useState } from 'react'
import { INDEXER_URL } from './Explore.jsx'
import { FAMILY, FAMILY_CA } from './family.js'
import { fmtUsdCap, usdMarketCap } from './curve.mjs'
import { Avatar, CopyableAddress } from './token.jsx'

export default function FamilyToken({ mint }) {
  const [data, setData] = useState({ state: 'loading' })

  const load = useCallback(async () => {
    try {
      const r = await fetch(`${INDEXER_URL}/api/family`)
      if (!r.ok) { setData({ state: 'missing' }); return }
      setData({ state: 'ok', row: await r.json() })
    } catch (e) { setData({ state: 'offline', error: e.message }) }
  }, [])

  useEffect(() => { load(); const t = setInterval(load, 20_000); return () => clearInterval(t) }, [load])

  const row = data.row
  const ca = row?.mint || FAMILY_CA || mint
  // ⛔ Dollars only when a SOL price came with the row. Converting at a rate we made up is how a
  // market cap becomes fiction — see market.mjs.
  const usd = row && row.marketCap != null && row.solUsd
    ? fmtUsdCap(usdMarketCap(row.marketCap, row.solUsd))
    : null

  return (
    <section className="page">
      <a className="back-link" href="/explore">← All launches</a>

      <div className="sim" style={{ marginBottom: 22 }}>
        <div className="sim-body tok-page">
          <Avatar image={FAMILY.image} symbol={FAMILY.symbol} size={72} />
          {/* Ticker as the headline, name under it — what the coin is traded and searched by,
              with the name as its gloss. ⚠ The same order as the sale page: the two are one
              layout, and a coin should not introduce itself differently depending on how it was
              launched. */}
          <h1 className="tok-page-h">{FAMILY.symbol}</h1>
          <p className="tok-page-sub">{FAMILY.name}</p>
          {/* ⚠ `MC`, not "market cap ... from its bonding curve". Where the number comes from is
              this code's problem, not the reader's — and it changes under them at graduation. */}
          {usd && (
            <p className="tok-page-cap">
              <strong className="mono">{usd}</strong> <span className="dim">MC</span>
            </p>
          )}

          {ca && <CopyableAddress value={ca} />}

          {ca && (
            <div style={{ marginTop: 18 }}>
              <a className="btn primary" href={`https://pump.fun/coin/${ca}`} target="_blank" rel="noreferrer">Trade it</a>
              <a className="btn" style={{ marginLeft: 8 }} href={`https://solscan.io/token/${ca}`} target="_blank" rel="noreferrer">Solscan</a>
            </div>
          )}

          {data.state === 'missing' && (
            <p className="note note-center" style={{ marginTop: 20 }}>
              This token is not configured yet.
            </p>
          )}
          {data.state === 'offline' && (
            <p className="note note-center" style={{ marginTop: 20 }}>
              The launch index is not reachable, so its market cannot be read right now.
            </p>
          )}
        </div>
      </div>
    </section>
  )
}
