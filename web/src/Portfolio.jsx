/**
 * Everything one wallet is in, across every sale.
 *
 * ⭐ Looked up by ADDRESS, not only by the connected wallet. Buyers pay from the FOMO app, whose
 * wallet cannot connect to this site, so they paste their FOMO wallet address instead. There are
 * no action buttons: tokens and refunds are pushed by the keeper, nobody claims.
 *
 * Without this a depositor can only see a position by pasting the sale address it belongs to, one
 * at a time — which is exactly the state someone is in when they have forgotten which sale they
 * deposited into, and is how money gets left unclaimed.
 *
 * ## How it finds them
 *
 * A position is a PDA of (sale, owner), so given the sale list there is nothing to search: derive
 * the address for each and read them in one batched `getMultipleAccounts` per hundred. No
 * `getProgramAccounts`, which is 403-blocked here anyway, and no index of positions to maintain —
 * the derivation IS the index.
 *
 * The sale list still comes from the indexer, so this page inherits that dependency and says so
 * when it is missing rather than reporting an empty portfolio, which would be a lie a depositor
 * might act on.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { queryOf } from './router.js'
import { PublicKey } from '@solana/web3.js'
import { connectionFor, clockSkew } from './chain.js'
import { positionAddress, decodePosition, RPC_BATCH } from './program.mjs'
import { Avatar, PHASE_LABEL, PHASE_TONE, phaseOf, countdown } from './token.jsx'
import { INDEXER_URL } from './Explore.jsx'

const fmt = (n, d = 0) => Number(n).toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d })
/**
 * A portfolio can hold positions in both denominations at once, so nothing here may add them
 * together — 1 SOL and 1 USDC are not two of anything. Totals are kept per quote and rendered as
 * separate figures.
 */
const QUOTE = { sol: { label: 'SOL', decimals: 9 }, usdc: { label: 'USDC', decimals: 6 } }

/**
 * What a position is actually owed — the QUOTED allocation scaled by what the raise really bought.
 *
 * ⛔ `position.allocation` is the number the curve promised at the pool's rate when the money
 * arrived. The coin is bought with whatever SOL the swap returned, so the delivered figure is that
 * allocation times `tokensReceived / sold` — one factor for everyone. Showing the raw allocation
 * overstates what a wallet holds by the swap's cost, on the page whose whole job is saying what it
 * holds.
 *
 * ⚠ The sale's figures arrive from the indexer as JS numbers and the position's as BigInt, so they
 * cannot be multiplied without converting. That mix is how a page ends up throwing on one row.
 */
const owedTokens = (position, sale) =>
  sale?.sold > 0 && sale?.tokensReceived > 0
    ? (position.allocation * BigInt(sale.tokensReceived)) / BigInt(sale.sold)
    : position.allocation
const unitsOf = (sale) => QUOTE[sale?.quoteLabel] ?? QUOTE.sol
const inQuote = (v, sale) => Number(v) / 10 ** unitsOf(sale).decimals
const toTok = (t) => Number(t) / 1e6

/** What happens next for a position. Nothing here asks the reader to act. */
function statusNote(phase, position) {
  // A migrated coin is a launched coin that has since graduated: the position settles identically.
  if (phase === 'launched' || phase === 'migrated') return position.claimed ? 'Tokens delivered' : 'Tokens on the way'
  if (phase === 'failed') return position.claimed ? 'Refunded' : 'Refund on the way'
  if (phase === 'awaiting-launch') return 'Launching'
  if (phase === 'expired') return 'Refund on the way'
  return 'Window open'
}

export default function Portfolio({ chain, wallet }) {
  const [state, setState] = useState({ status: 'idle', rows: [] })
  // `/portfolio?address=…` fills the lookup, so a link can open someone's positions directly.
  const [typed, setTyped] = useState(() => queryOf('address') ?? '')
  const typedKey = (() => { try { return typed.trim() ? new PublicKey(typed.trim()).toBase58() : null } catch { return undefined } })()
  const owner = typedKey || wallet.publicKey

  const load = useCallback(async () => {
    if (!owner) { setState({ status: 'nowallet', rows: [] }); return }
    setState((p) => ({ ...p, status: p.rows.length ? p.status : 'loading' }))
    let sales
    try {
      const res = await fetch(`${INDEXER_URL}/api/sales`)
      if (!res.ok) throw new Error(`the indexer returned HTTP ${res.status}`)
      sales = (await res.json()).sales ?? []
    } catch (e) {
      setState({ status: 'offline', rows: [], error: e.message })
      return
    }

    const conn = connectionFor(chain)
    const me = new PublicKey(owner)
    const skew = await clockSkew(conn)
    const now = Math.floor(Date.now() / 1000) - skew

    const rows = []
    // ⛔ RPC_BATCH, not 100 — see program.mjs. A portfolio spanning more than ten sales asked for
    // more accounts than this endpoint allows and came back as a 403, which reads as "no positions".
    for (let i = 0; i < sales.length; i += RPC_BATCH) {
      const chunk = sales.slice(i, i + RPC_BATCH)
      const infos = await conn.getMultipleAccountsInfo(
        chunk.map((s) => positionAddress(new PublicKey(s.address), me)))
      chunk.forEach((sale, j) => {
        const info = infos[j]
        if (!info?.data) return
        let position
        try { position = decodePosition(info.data) } catch { return }
        if (position.deposited === 0n) return
        rows.push({ sale, position, phase: phaseOf(sale, now) })
      })
    }
    // Anything needing a press first, then the still-open windows, then what is already settled.
    const rank = { launched: 0, failed: 0, 'awaiting-launch': 1, open: 2, expired: 3 }
    rows.sort((a, b) =>
      (a.position.claimed - b.position.claimed) ||
      ((rank[a.phase] ?? 9) - (rank[b.phase] ?? 9)) ||
      Number(b.position.deposited - a.position.deposited))
    setState({ status: 'ok', rows, now, skew })
  }, [owner, chain])

  useEffect(() => { load() }, [load])

  const totals = useMemo(() => {
    // ⚠ `deposited` is a map keyed by quote, not a sum. Adding a lamport figure to a six-decimal
    // one produces a number that is wrong in a way nothing on the page would reveal.
    const t = { deposited: {}, allocation: 0n, claimable: 0, open: 0 }
    for (const r of state.rows) {
      const label = r.sale?.quoteLabel ?? 'sol'
      t.deposited[label] = (t.deposited[label] ?? 0n) + r.position.deposited
      t.allocation += owedTokens(r.position, r.sale)
      if (!r.position.claimed && (r.phase === 'launched' || r.phase === 'failed')) t.claimable++
      if (r.phase === 'open') t.open++
    }
    return t
  }, [state.rows])

  return (
    <section className="page">
      {/* ⭐ Centred on the page's axis, like Explore and How it works. It used to be a split row
          with the title left and the totals right, which left the search field hanging under a
          wide empty gap — the totals now sit under the title, centred with it. */}
      <div className="explore-head center">
        <div>
          <h1>Your positions</h1>
          <p className="lede">Every sale a wallet bought into. Paste the address of your FOMO wallet.</p>
        </div>
        {state.status === 'ok' && state.rows.length > 0 && (
          <div className="stats-inline stats-inline-center">
            {Object.entries(totals.deposited).map(([label, sum]) => (
              <div key={label}>
                <strong className="mono">{fmt(Number(sum) / 10 ** QUOTE[label].decimals, 2)}</strong>
                <span>{QUOTE[label].label} in</span>
              </div>
            ))}
            <div><strong className="mono">{fmt(toTok(totals.allocation))}</strong><span>tokens</span></div>

          </div>
        )}
      </div>

      <div className="search" style={{ marginBottom: 22, maxWidth: 560, marginLeft: 'auto', marginRight: 'auto' }}>
        <input className="field mono" value={typed} onChange={(e) => setTyped(e.target.value)}
               placeholder={wallet.publicKey ? `Your connected wallet, or paste any address` : 'Paste your FOMO wallet address'}
               aria-label="Wallet address" />
      </div>
      {typedKey === undefined && <p className="note warn" style={{ marginBottom: 22 }}>That is not a Solana address.</p>}

      {state.status === 'nowallet' ? (
        <div className="empty">
          <span className="ico" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 7h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/><path d="M3 7V6a2 2 0 0 1 2-2h11"/><circle cx="16" cy="13" r="1.4"/></svg></span>
          <h3>Whose positions?</h3>
          <p>Paste the wallet address you sent USDC from — in FOMO it is under your Solana wallet — or connect a wallet.</p>
        </div>
      ) : state.status === 'offline' ? (
        <div className="empty">
          <span className="ico" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18Z"/><path d="M12 8v5"/><path d="M12 16.2h.01"/></svg></span>
          <h3>The launch index is not reachable</h3>
          <p>
            Positions are found by deriving one address per known sale, and the list of sales comes
            from the indexer at <span className="mono">{INDEXER_URL}</span>. Without it this page
            cannot tell an empty portfolio from an unreachable service, so it reports neither.
          </p>
          <p className="mono dim">{state.error}</p>
          <p>You can still open any sale directly by address on the <a href="/explore">Sale</a> tab.</p>
        </div>
      ) : state.status === 'loading' ? (
        <div className="empty"><p className="dim">Looking up positions…</p></div>
      ) : state.rows.length === 0 ? (
        <div className="empty">
          <h3>Nothing yet</h3>
          <p>This wallet has no buys in any sale the index knows about. <a href="/explore">Find an open window</a>.</p>
        </div>
      ) : (
        <div className="tok-table">
          <div className="tok-row pos head">
            <div>Token</div>
            <div className="num">You put in</div>
            <div className="num">You get</div>
            <div>Status</div>
            <div className="num">Next</div>
          </div>
          {state.rows.map((row) => {
            const { sale, position, phase } = row
            return (
              <div className="tok-row pos" key={sale.address}>
                <a className="tok-id" href={`/sale/${sale.address}`}>
                  <Avatar image={sale.image} symbol={sale.symbol} />
                  <div className="tok-name">
                    <strong>{sale.symbol || '—'}</strong>
                    <span>{sale.name}</span>
                    {/* On narrow screens the status columns are hidden, so the status rides here. */}
                    <span className="pos-mobile-status">
                      <span className={`pill ${PHASE_TONE[phase] ?? 'dead'}`}>{PHASE_LABEL[phase] ?? phase}</span>
                      <span className="dim">{statusNote(phase, position)}</span>
                    </span>
                  </div>
                </a>

                <div className="tok-cell mono num">{fmt(inQuote(position.deposited, sale), 2)} {unitsOf(sale).label}</div>
                <div className="tok-cell mono num">{fmt(toTok(owedTokens(position, sale)))}</div>

                <div className="tok-cell">
                  <span className={`pill ${PHASE_TONE[phase] ?? 'dead'}`}>{PHASE_LABEL[phase] ?? phase}</span>
                  {phase === 'open' && state.now && (
                    <span className="dim mono" style={{ marginLeft: 8, fontSize: 12 }}>
                      {countdown(Number(sale.windowEnd) - state.now)}
                    </span>
                  )}
                </div>

                <div className="tok-cell num"><span className="dim" style={{ fontSize: 13 }}>{statusNote(phase, position)}</span></div>
              </div>
            )
          })}
        </div>
      )}

    </section>
  )
}
