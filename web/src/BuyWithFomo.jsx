/**
 * "Buy with FOMO" — the popup that turns a FOMO send into as few taps as FOMO allows.
 *
 * ⚠ What FOMO allows, measured 16 Sep 2026: its universal links (fomo.family/.well-known) open the
 * app on trending, coins, profiles and the feed — there is NO link into Send with an address and
 * amount filled in. So the shortest path is:
 *   phone:   one tap here copies the address AND opens the FOMO app → cash → Withdraw → amount → paste
 *   desktop: one click copies the address AND opens FOMO web in a new tab → the same path; or scan
 *            the QR from the app
 * (FOMO web's path, looked at 16 Sep 2026: cash → Withdraw → "Withdraw to crypto wallet" → dollar
 * amount → Continue → address.)
 *
 * The popup then watches the sale's buy history and says so the moment a matching buy is recorded,
 * so nobody is left wondering whether it worked.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import QRCode from 'qrcode'
import { INDEXER_URL } from './Explore.jsx'

const isPhone = () => typeof navigator !== 'undefined' && /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
const fmt = (n, d = 0) => Number(n).toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d })

export default function BuyWithFomo({ open, onClose, saleAddress, depositAddress, symbol, amount, setAmount, receive, error, minBuy }) {
  const [copied, setCopied] = useState(null)
  const [qr, setQr] = useState(null)
  const [status, setStatus] = useState({ state: 'waiting' })
  const baseline = useRef(null)
  // The poll reads the CURRENT amount, not the one it was created with: the field can change after
  // the popup opens (the default settles once the sale loads, and people change it).
  const amountRef = useRef(amount)
  amountRef.current = amount
  const phone = useMemo(isPhone, [])

  // QR of the plain address: FOMO's Send screen scans addresses, and a plain address is the one
  // format every scanner accepts.
  useEffect(() => {
    if (!open || phone || !depositAddress) return
    QRCode.toDataURL(depositAddress, { margin: 1, width: 220, color: { dark: '#06070e', light: '#ffffff' } }).then(setQr).catch(() => setQr(null))
  }, [open, phone, depositAddress])

  // Watch for the buy to be recorded: remember what the history held when the popup opened, then
  // report the first new buy. A buy for the amount typed here is almost certainly this person's.
  useEffect(() => {
    if (!open) return
    let dead = false
    baseline.current = null
    setStatus({ state: 'waiting' })
    const poll = async () => {
      try {
        const r = await fetch(`${INDEXER_URL}/api/sales/${saleAddress}/history`)
        const deposits = (await r.json()).deposits ?? []
        if (dead) return
        if (baseline.current === null) { baseline.current = new Set(deposits.map((d) => d.signature)); return }
        const fresh = deposits.filter((d) => !baseline.current.has(d.signature))
        if (fresh.length) {
          const want = Math.round((parseFloat(amountRef.current) || 0) * 1e6)
          const mine = fresh.find((d) => Number(d.amount) === want)
          const pick = mine ?? fresh[fresh.length - 1]
          setStatus({ state: mine ? 'mine' : 'someone', amount: Number(pick.amount) / 1e6, tokens: Number(pick.allocation) / 1e6, position: deposits.indexOf(pick) + 1 })
        }
      } catch { /* try again on the next tick */ }
    }
    poll()
    const t = setInterval(poll, 4000)
    return () => { dead = true; clearInterval(t) }
  }, [open, saleAddress]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open) return
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  const copy = async (what, text) => {
    try { await navigator.clipboard.writeText(text) } catch { /* the address is still on screen */ }
    setCopied(what)
    setTimeout(() => setCopied(null), 2000)
  }
  const copyAndOpen = async () => {
    await copy('address', depositAddress)
    // A universal link: on a phone with FOMO installed this opens the app. On a computer it opens FOMO
    // web in a new tab, so this page — and the confirmation below — stays open.
    if (phone) window.location.href = 'https://fomo.family/'
    else window.open('https://fomo.family/', '_blank', 'noopener')
  }

  return (
    <div className="bwf-scrim" onClick={onClose} role="presentation">
      <div className="bwf" role="dialog" aria-modal="true" aria-label={`Buy ${symbol} with FOMO`} onClick={(e) => e.stopPropagation()}>
        <div className="bwf-head">
          <h2>Buy <span className="mono">${symbol}</span> with FOMO</h2>
          <button className="bwf-x" onClick={onClose} aria-label="Close">×</button>
        </div>

        <div className="bwf-step">
          <span className="bwf-n">1</span>
          <div className="bwf-body">
            <strong>How much USDC?</strong>
            <div className="bwf-amount">
              <input className="field mono" value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" aria-label="Amount in USDC" />
              <span className="bwf-unit">USDC</span>
            </div>
            <div className="bwf-chips">
              {[10, 25, 50, 100].map((v) => (
                <button key={v} className={`bwf-chip ${String(v) === String(amount) ? 'on' : ''}`} onClick={() => setAmount(String(v))}>{v}</button>
              ))}
            </div>
            <p className={`bwf-quote ${error ? 'warn' : ''}`}>
              {/* ⚠ "about" is doing real work here and stays. The coin trades in SOL and the raise
                  is swapped when the window shuts, so the final count is this scaled by what the
                  swap actually bought — the same factor for everyone, a fraction of a percent.
                  The clause explaining that was cut for length, but the word that keeps the
                  sentence honest is not the clause, it is "about". */}
              {error ?? (receive
                ? <>You get about <b>{fmt(receive)} {symbol}</b></>
                : `Minimum ${minBuy} USDC.`)}
            </p>
          </div>
        </div>

        <div className="bwf-step">
          <span className="bwf-n">2</span>
          <div className="bwf-body">
            <strong>Copy the address and open FOMO</strong>
            <button className="btn primary lg bwf-go" onClick={copyAndOpen}>
              {copied === 'address' ? 'Copied, opening FOMO…' : 'Open FOMO'}
            </button>
            {!phone && qr && (
              <details className="bwf-qr-wrap">
                <summary>Using the FOMO app on your phone? Scan instead</summary>
                <img className="bwf-qr" src={qr} alt="Deposit address QR code" width="180" height="180" />
              </details>
            )}
            <button className="bwf-addr mono" onClick={() => copy('address', depositAddress)} title="Copy the address">
              <span>{depositAddress}</span>
              <em>{copied === 'address' ? 'Copied' : 'Copy'}</em>
            </button>
          </div>
        </div>

        <div className={`bwf-status ${status.state}`}>
          {status.state === 'waiting' && <><i className="bwf-pulse" /> Waiting for your send. It shows here within a minute of landing.</>}
          {status.state === 'mine' && <>✓ Your buy is recorded: {fmt(status.amount, 2)} USDC, #{status.position} in line, about {fmt(status.tokens)} {symbol}. Tokens arrive in your FOMO wallet at launch.</>}
          {status.state === 'someone' && <>A {fmt(status.amount, 2)} USDC buy was just recorded. If that was yours, you're in: #{status.position} in line.</>}
        </div>

      </div>
    </div>
  )
}
