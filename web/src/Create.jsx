import { useEffect, useRef, useState } from 'react'
import { PublicKey, Keypair } from '@solana/web3.js'
import { buildInitializeSaleTx } from './program.mjs'
import { validateMetadataUri, uploadMetadata, MAX_NAME, MAX_SYMBOL } from './metadata.mjs'
import { readFeeSchedule, feesAtMarketCap } from './fees.mjs'
import { connectionFor } from './chain.js'
import { Avatar, CopyableAddress } from './token.jsx'
import { INDEXER_URL } from './Explore.jsx'

const logo = '/logo.png'
import { USDC_MINT } from './program.mjs'
import {
  ShadowCurve, VS0, RT0, VT0,
  solCost, totalWithFees, FEE_PROTOCOL_BPS, FEE_CREATOR_BPS,
} from './curve.mjs'
import { launchingDisabled } from './family.js'

/**
 * The windows a creator may pick. The program's own bound is 60 seconds to 30 days; this is the
 * narrower set the product offers, so nobody opens a week-long window by typing an extra digit.
 */
const WINDOWS = [
  { s: '300', label: '5 min' },
  { s: '600', label: '10 min' },
  { s: '900', label: '15 min' },
  { s: '1800', label: '30 min' },
  { s: '3600', label: '1 hour' },
  { s: '14400', label: '4 hours' },
  { s: '43200', label: '12 hours' },
  { s: '86400', label: '24 hours' },
]

/**
 * Everything the curve can absorb, all-in — the largest hard cap the program will accept.
 *
 * ⚠ Computed with the SAME fee legs the sale is opened with, because the program's own bound is
 * `total_with_fees(sol_cost(RT0))` at those rates. A base unit is shaved off so a rounding
 * disagreement between the two implementations can never turn into `HardCapExceedsCurve` on a
 * transaction the creator has already signed.
 */
const capacityFor = (fees) => {
  // The program checks `hard_cap <= total_with_fees(sol_cost(RT0, VS0, VT0))` at the sale's own
  // fee legs. Same two functions here, same inputs — `differential.test.mjs` keeps the two
  // implementations agreeing to the base unit.
  // ⛔ VS0, not VQ0_USDC: the coin launches on pump.fun's SOL curve. Buyers pay USDC and the raise
  // is swapped at the close, but every cap on a sale is measured in lamports.
  const curveIn = solCost(RT0, VS0, VT0)
  const bps = fees ?? { protocolBps: FEE_PROTOCOL_BPS, creatorBps: FEE_CREATOR_BPS }
  return totalWithFees(curveIn, BigInt(bps.protocolBps), BigInt(bps.creatorBps)) - 1n
}

/** How long after the window closes the launch may still happen. See `launchWindow` below. */
const LAUNCH_DEADLINE_SECONDS = 12 * 3600

const USDC = (n) => BigInt(Math.round(Number(n) * 1e6))
const fmt = (n, d = 0) => Number(n).toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d })


export default function Create({ chain, wallet, undeployed = false }) {
  const [f, setF] = useState({
    name: '', symbol: '', description: '',
    twitter: '', website: '',
    windowSeconds: '300',
    // ⛔ Minimum raise defaults to ZERO on purpose: a launch should not be conditional on other
    // people turning up. Whatever came in buys the curve, and a creator who does want a floor can
    // still type one — it is the only thing that sends the money back instead.

    // Always USDC: a send from the FOMO app moves USDC, and the program refuses a SOL sale.
    quote: 'usdc',
    // Where the creator fee goes: false = to the creator, true = to the coin's holders. Off by
    // default, as pump.fun's own form defaults it.
    //
    // ⛔⛔ Permanent. It is an argument of `create_v2`, applied when the window closes, and
    // pump.fun exposes no way to change it for a coin afterwards.
    holderRewards: false,
    // ⭐ What the coin is paired with on pump.fun: null = SOL, or a mint from pump.fun's own list of
    // custom liquidity tokens — the same choice pump.fun's form offers. Buyers pay USDC either way.
    pair: null,
    // pump.fun lets a custom-pair coin choose its creator fee, 0..3%. Ignored for SOL, whose
    // creator fee is pump.fun's fixed schedule. Permanent, like the pair itself.
    pairFeeBps: 30,
    uri: '',
  })
  // pump.fun's custom-pair list, from the indexer (which reads pump.fun's own account).
  const [pairs, setPairs] = useState(null)
  const [pairQuery, setPairQuery] = useState('')
  // "Custom" is open. Separate from `f.pair` so the list can be open with nothing picked yet.
  const [pairMode, setPairMode] = useState(false)
  // The list is open while choosing; picking a token closes it and the bar shows the choice.
  const [pairListOpen, setPairListOpen] = useState(true)
  useEffect(() => {
    let dead = false
    fetch(`${INDEXER_URL}/api/pairs`).then((r) => r.json())
      .then((d) => { if (!dead) setPairs(d.pairs ?? []) })
      .catch(() => { if (!dead) setPairs([]) })
    return () => { dead = true }
  }, [])
  const pairInfo = f.pair ? pairs?.find((p) => p.mint === f.pair) ?? { mint: f.pair } : null
  const set = (k) => (e) => setF((p) => ({ ...p, [k]: e.target.value }))
  /** ⛔ Read once at render, from the one value that also decides whether the coin is shown. */
  const gated = launchingDisabled()
  const [gateOpen, setGateOpen] = useState(false)
  /* ⛔ Escape closes it, like every other dialog here. Without this the panel would claim three
     ways out and have two, and the one it lied about is the one a keyboard user reaches for. */
  useEffect(() => {
    if (!gateOpen) return
    const onKey = (e) => { if (e.key === 'Escape') setGateOpen(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [gateOpen])
  /* The same for the launched dialog — it offers the same three ways out, so it has to honour
     all three. ⚠ Declared here beside `gateOpen`'s, not next to the markup, because `result` is
     defined below and a hook cannot move but a reader can. */
  const [file, setFile] = useState(null)
  const [dragging, setDragging] = useState(false)
  const [check, setCheck] = useState(null)
  const [fees, setFees] = useState(null)
  const [busy, setBusy] = useState(null)
  const [result, setResult] = useState(null)
  useEffect(() => {
    if (!result) return
    const onKey = (e) => { if (e.key === 'Escape') setResult(null) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [result])
  const [error, setError] = useState(null)

  useEffect(() => {
    readFeeSchedule(connectionFor(chain))
      .then((s) => setFees(feesAtMarketCap(s, 27_960_000_000n)))
      .catch(() => setFees(null))
  }, [chain])

  /**
   * Publishes the image and these details as the coin's metadata, and returns the URI.
   *
   * ⭐ Called by `create`, not by a button. Uploading is the ONLY way a coin gets its metadata
   * here — there is no field to paste a URI into, because a document we did not write is one
   * nobody checked, and this one is frozen at launch and can never be edited
   * ([[pumpfun-create-v2-metadata-has-no-authority]] — a v1 coin's is equally unowned).
   *
   * ⛔ It runs at LAUNCH rather than when the image is chosen, and that ordering is the point:
   * the metadata has to be built from the FINAL name, symbol, description and socials. Freezing
   * it the moment a file is dropped would pin whatever was half-typed at that second, forever.
   *
   * `uploadedFor` is the exact input it was built from, so pressing the button again after a
   * failed transaction reuses the pin instead of publishing a second copy of the same image.
   */
  const uploadedFor = useRef(null)
  const freezeMetadata = async () => {
    const inputs = JSON.stringify([file?.name, file?.size, file?.lastModified, f.name, f.symbol, f.description, f.twitter.trim(), f.website.trim()])
    if (uploadedFor.current === inputs && f.uri) return f.uri
    const out = await uploadMetadata({
      file, name: f.name, symbol: f.symbol, description: f.description,
      twitter: f.twitter.trim() || undefined,
      website: f.website.trim() || undefined,
    })
    const v = await validateMetadataUri(out.metadataUri)
    setCheck(v)
    if (!v.ok) throw new Error(`The metadata is not fit to launch with: ${v.errors.join(' ')}`)
    uploadedFor.current = inputs
    setF((p) => ({ ...p, uri: out.metadataUri }))
    return out.metadataUri
  }

  const create = async () => {
    setBusy('create'); setError(null); setResult(null)
    try {
      const uri = await freezeMetadata()
      const conn = connectionFor(chain)
      const authority = new PublicKey(wallet.publicKey)
      const saleId = BigInt(Date.now())

      // No coin address is picked here: the launch picks it (ending in `fomo`), so nobody can know
      // it early enough to block the launch.

      // A throwaway wallet whose USDC account becomes this sale's deposit address. It signs once,
      // here, to hand that account to the vault, and is never needed again.
      const depositWallet = Keypair.generate()
      const { sale, tx } = await buildInitializeSaleTx(conn, authority, saleId, {
        windowSeconds: Number(f.windowSeconds),
        /**
         * ⛔ NOT a delay. The coin launches the moment the window ends — the watcher cranks it as
         * soon as the attester has decided every transfer. This is the DEADLINE by which that must
         * have happened: past it, the sale can be failed and every buy refunded instead, which is
         * what protects buyers if the cranker is dead. The program allows 1 hour to 7 days.
         *
         * Fixed rather than asked: a creator reading "launch window" as "how long until my coin
         * launches" would set it to the smallest number they could, which buys them nothing and
         * costs them the safety margin.
         */
        launchWindow: LAUNCH_DEADLINE_SECONDS,
        // ⚠ In the QUOTE's base units. USDC is 6 decimals where SOL is 9, so reusing the
        // lamport helper for a USDC sale would be out by a factor of a thousand.
        /**
         * ⛔ None of these are the creator's to choose any more, and each is pinned to the only
         * value that makes sense on chain:
         *
         *  - **Hard cap** = everything the curve can absorb. The program refuses a cap above that
         *    (`HardCapExceedsCurve`), because deposits past it could never be deployed — so this
         *    IS "no cap": the sale stops when the coin is sold out, not before.
         *  - **Per wallet cap** = the same figure, which leaves the PROTOCOL ceiling as the only
         *    limit a buyer meets: no wallet may end the window holding more than 3% of supply.
         *    ⭐ That ceiling is in TOKENS, so what it costs MOVES with the curve — about 125 USDC
         *    at the open, ~190 after a thousand of queue, ~598 after five thousand. Everyone is
         *    held to the same share of the coin, not to the same number of dollars.
         *  - **Minimum raise** = 0. A launch is never conditional on other people turning up.
         */
        perWalletCap: capacity, hardCap: capacity, minRaise: 0n,
        quote: f.quote,
        holderRewards: f.holderRewards,
        quoteMint: USDC_MINT,
        // Named in the same transaction as the sale, so a pair sale never exists without its pair.
        ...(f.pair ? { pairMint: f.pair, pairCreatorFeeBps: f.pairFeeBps } : {}),
        protocolFeeBps: Number(fees?.protocolBps ?? 95n), creatorFeeBps: Number(fees?.creatorBps ?? 30n),
        creatorFeeRecipient: authority,
        name: f.name, symbol: f.symbol, uri,
      }, depositWallet)
      const sig = await wallet.signAndSend(tx)
      setResult({ sale: sale.toBase58(), sig })
    } catch (e) { setError(e.message ?? String(e)) } finally { setBusy(null) }
  }

  // The chosen file, as something an <img> can show. Revoked on change: without this every
  // re-pick leaks a blob URL for the life of the tab.
  const [preview, setPreview] = useState(null)
  useEffect(() => {
    if (!file) { setPreview(null); return }
    const url = URL.createObjectURL(file)
    setPreview(url)
    return () => { URL.revokeObjectURL(url) }
  }, [file])

  // The quote's own unit, and its label. One place, so a figure and its unit cannot disagree.
  const QUOTE_UNIT = { sol: 'SOL', usdc: 'USDC' }
  const unitLabel = QUOTE_UNIT[f.quote]
  const units = (v) => BigInt(Math.round((parseFloat(v) || 0) * 1e6))

  // What the form now decides for the creator: the whole curve, and the protocol's own ceiling.
  const capacity = capacityFor(fees)
  // The image and the two names are all the metadata needs; it is published by `create` itself,
  // so there is no separate check to wait for.
  const metaReady = !!file && !!f.name && !!f.symbol
  // ⛔ `undeployed` is part of readiness, not a separate warning. Everything before the button —
  // grinding the vanity mint, uploading the metadata — costs the visitor time and publishes an
  // image, and all of it is wasted if the transaction cannot land.
  // "Custom" with nothing picked is not a SOL launch by default; it is unfinished.
  const pairReady = !pairMode || f.pair !== null
  const ready = metaReady && f.name && f.symbol && wallet.publicKey && !busy && !undeployed && pairReady

  return (
    <section className="page">
      {/* ⛔ No eyebrow. "LAUNCH" sat directly over "Launch a coin" and said it twice — the same
          reason How it works lost its own. */}
      <div className="explore-head center">
        <h1>Launch a coin</h1>
      </div>

      {/* Work on the left, context on the right. A long form with nothing beside it gives no
          sense of what is being made until it already exists. */}
      <div className="two-col">
      <div className="col-main">
      {/* No card head and no warning block: the operator wants the form to open on the fields.
          ⛔ The permanence itself is unchanged — pump.fun freezes name, symbol and image at launch
          and nobody can repair them — it is just no longer stated here. */}
      <div className="sim" style={{ marginBottom: 22 }}>
        <div className="sim-body">
          <div className="controls" style={{ marginBottom: 18 }}>
            <label className="ctl">
              <span className="lbl"><span>Name</span><span className="val">{f.name.length}/{MAX_NAME}</span></span>
              <input className="field" value={f.name} onChange={set('name')} maxLength={MAX_NAME} placeholder="Pump Family" />
            </label>
            <label className="ctl">
              <span className="lbl"><span>Symbol</span><span className="val">{f.symbol.length}/{MAX_SYMBOL}</span></span>
              <input className="field" value={f.symbol} onChange={set('symbol')} maxLength={MAX_SYMBOL} placeholder="FAMILY" />
            </label>
          </div>
          <label className="ctl" style={{ marginBottom: 18 }}>
            <span className="lbl"><span>Description</span></span>
            <input className="field" value={f.description} onChange={set('description')} />
          </label>

          {/* Written into the metadata document, so they freeze with it. Collected before the
              upload rather than after, because after is too late — permanently. */}
          <div className="grid3" style={{ marginBottom: 18 }}>
            <label className="ctl">
              <span className="lbl"><span>X</span><span className="val">optional</span></span>
              <input className="field" value={f.twitter} onChange={set('twitter')} placeholder="https://x.com/…" />
            </label>
            <label className="ctl">
              <span className="lbl"><span>Website</span><span className="val">optional</span></span>
              <input className="field" value={f.website} onChange={set('website')} placeholder="https://…" />
            </label>
          </div>

          {/* The image field, the way ponscharity.family shows one: the picture itself beside the
              target you drop onto, so the field IS the preview rather than a button with a
              filename next to it. Empty, the tile holds our own mark — a placeholder that looks
              like something, which is also how you can tell nothing has been chosen yet. */}
          <span className="lbl"><span>Coin image</span><span className="val">{file ? file.name : 'required'}</span></span>
          <div className="imgfield">
            <span className={`imgfield-tile${preview ? ' has' : ''}`}>
              {preview
                ? <img src={preview} alt="" />
                : <img className="imgfield-mark" src={logo} alt="" />}
            </span>
            <label
              className={`imgfield-drop${dragging ? ' over' : ''}`}
              onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault(); setDragging(false)
                const dropped = e.dataTransfer?.files?.[0]
                if (dropped) setFile(dropped)
              }}
            >
              <input type="file" accept="image/png,image/jpeg,image/gif,image/webp"
                     onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
              <strong>{file ? 'Drop another, or click to change' : 'Drop an image, or click to choose'}</strong>
              <span>PNG, JPEG, GIF or WebP, up to 4 MB</span>
            </label>
          </div>
          {/* No upload button and nowhere to paste a URI: the image and these details ARE the
              metadata, published when the sale is opened. One way in, so what the coin carries is
              always something this form built and checked. */}
          {check && (
            <div className="note" style={{ borderColor: check.ok ? 'var(--accent)' : 'var(--warn)' }}>
              <strong>{check.ok ? 'Fit to freeze forever.' : 'Not fit to launch with.'}</strong>
              {check.errors.map((e, i) => <div key={i} style={{ color: 'var(--warn)' }}>{e}</div>)}
              {check.warnings.map((w, i) => <div key={i}>{w}</div>)}
            </div>
          )}
        </div>
      </div>

      <div className="sim" style={{ marginBottom: 22 }}>
        <div className="sim-head center"><div><h2>Creator rewards</h2></div></div>
        <div className="sim-body">
          <div className="chips pair" role="radiogroup" aria-label="Creator rewards">
            {[[false, 'To you'], [true, 'To holders']].map(([v, label]) => (
              <button
                key={label}
                type="button"
                role="radio"
                aria-checked={v === f.holderRewards}
                className={`chip${v === f.holderRewards ? ' on' : ''}`}
                onClick={() => setF((p) => ({ ...p, holderRewards: v }))}
              >{label}</button>
            ))}
          </div>
          <p className="note note-center">
            {f.holderRewards
              ? <>Every trade&rsquo;s creator fee is paid out to the people holding the coin.</>
              : <>Every trade&rsquo;s creator fee is collected by your wallet on pump.fun.</>}
          </p>
        </div>
      </div>

      <div className="sim" style={{ marginBottom: 22 }}>
        <div className="sim-head center"><div><h2>Pair</h2></div></div>
        <div className="sim-body">
          <div className="chips pair" role="radiogroup" aria-label="Pair">
            {[[false, 'SOL'], [true, 'Custom']].map(([v, label]) => (
              <button
                key={label}
                type="button"
                role="radio"
                aria-checked={v === pairMode}
                className={`chip${v === pairMode ? ' on' : ''}`}
                onClick={() => { setPairMode(v); if (!v) { setF((p) => ({ ...p, pair: null })); setPairQuery(''); setPairListOpen(true) } }}
              >{label}</button>
            ))}
          </div>
          {pairMode && (
            <div className="pair-pick">
              {f.pair && !pairListOpen ? (
                /* The choice, shown in the bar itself. Clicking it opens the list again. */
                <button type="button" className="field pair-chosen" aria-label="Change pair token"
                        onClick={() => { setPairQuery(''); setPairListOpen(true) }}>
                  <Avatar image={pairInfo?.icon} symbol={pairInfo?.symbol ?? '?'} size={24} />
                  <b>{pairInfo?.symbol ?? `${f.pair.slice(0, 4)}…${f.pair.slice(-4)}`}</b>
                  <span>{pairInfo?.name ?? ''}</span>
                  <em>Change</em>
                </button>
              ) : (
              <input className="field" placeholder="Search a token or paste its address" autoFocus={!!f.pair}
                     value={pairQuery} onChange={(e) => setPairQuery(e.target.value)}
                     onKeyDown={(e) => { if (e.key === 'Escape' && f.pair) setPairListOpen(false) }} />
              )}
              {(!f.pair || pairListOpen) && (
              <div className="pair-list" role="listbox" aria-label="Pair token">
                {pairs === null && <div className="note">Loading pump.fun&rsquo;s pair tokens…</div>}
                {pairs?.length === 0 && <div className="note">The pair list could not be loaded.</div>}
                {(pairs ?? [])
                  .filter((p) => {
                    const q = pairQuery.trim().toLowerCase()
                    return !q || p.mint.toLowerCase() === q || (p.symbol ?? '').toLowerCase().includes(q) || (p.name ?? '').toLowerCase().includes(q)
                  })
                  .slice(0, 60)
                  .map((p) => (
                    <button key={p.mint} type="button" role="option" aria-selected={f.pair === p.mint}
                            className={`pair-row${f.pair === p.mint ? ' on' : ''}`}
                            onClick={() => { setF((x) => ({ ...x, pair: p.mint })); setPairListOpen(false); setPairQuery('') }}>
                      <Avatar image={p.icon} symbol={p.symbol ?? '?'} size={24} />
                      <b>{p.symbol ?? `${p.mint.slice(0, 4)}…${p.mint.slice(-4)}`}</b>
                      <span>{p.name ?? ''}</span>
                    </button>
                  ))}
              </div>
              )}
              <div className="sim-head center" style={{ padding: '16px 0 10px' }}><div><h2 style={{ fontSize: 15 }}>Creator fee</h2></div></div>
              <div className="chips fees" role="radiogroup" aria-label="Creator fee">
                {[0, 30, 100, 200, 300].map((bps) => (
                  <button key={bps} type="button" role="radio" aria-checked={f.pairFeeBps === bps}
                          className={`chip${f.pairFeeBps === bps ? ' on' : ''}`}
                          onClick={() => setF((p) => ({ ...p, pairFeeBps: bps }))}>{bps / 100}%</button>
                ))}
              </div>
            </div>
          )}
          <p className="note note-center">
            {f.pair
              ? <>Your coin trades against <strong>{pairInfo?.symbol ?? 'this token'}</strong> on pump.fun.</>
              : <>Your coin trades against SOL on pump.fun.</>}
          </p>
        </div>
      </div>

      <div className="sim" style={{ marginBottom: 22 }}>
        <div className="sim-head center"><div><h2>FOMO window</h2></div></div>
        <div className="sim-body">
          {/* ⛔ A fixed set, not a free number: the program refuses anything under a minute, a
              window of days leaves buyers' money parked, and a typo in a text field is a permanent
              sale. 5 minutes to 24 hours, chosen by the operator.
              ⭐ Chips rather than a dropdown: eight options are worth showing at once, and the
              card's own heading already says what is being chosen — the label under it repeated
              the heading, and the value beside the label repeated the control. */}
          <div className="chips" role="radiogroup" aria-label="FOMO window">
            {WINDOWS.map((w) => (
              <button
                key={w.s}
                type="button"
                role="radio"
                aria-checked={w.s === f.windowSeconds}
                className={`chip${w.s === f.windowSeconds ? ' on' : ''}`}
                onClick={() => setF((p) => ({ ...p, windowSeconds: w.s }))}
              >{w.label}</button>
            ))}
          </div>

          <p className="note note-center">
            No wallet may buy more than <strong>3% of supply</strong> when the window is active.
          </p>
        </div>
      </div>

      {/* ⭐ Back on the form from 21 Sep 2026. It came off when launches moved to SOL pairing,
          because `is_holder_reward` is a `create_v2` argument and the launch was v1 `create`.
          The launch is `create_v2` again, quoted in WSOL, so the choice is real once more.

          ⛔ It is the only permanent choice on this page besides the name and the ticker: it is
          applied when the window closes and pump.fun offers no way to change it after. The copy
          under it says so, because a radio group looks like a setting. */}


      </div>

      <aside className="col-side">
        {/* Everything here is the form's own state. It is a preview, so it shows what will exist
            rather than describing it, and it says nothing the fields have not been given. */}
        <div className="side-card">
          <div className="coin-card-top">
            <Avatar image={preview} symbol={f.symbol} size={44} />
            <div className="coin-card-id">
              <strong>{f.symbol || 'TICKER'}</strong>
              <span>{f.name || 'Your coin name'}</span>
            </div>
          </div>
          <div className="coin-card-rows">
            <div><span>FOMO Window</span><b className="mono">{WINDOWS.find((w) => w.s === f.windowSeconds)?.label ?? '—'}</b></div>
            <div><span>Creator rewards</span><b className="mono">{f.holderRewards ? 'Holders' : 'You'}</b></div>
            <div><span>Pair</span><b className="mono">{f.pair ? `${pairInfo?.symbol ?? 'Token'} · ${f.pairFeeBps / 100}% fee` : 'SOL'}</b></div>
          </div>
          {f.description && <p className="side-note">{f.description}</p>}
        </div>

        {/* The action sits WITH the summary it acts on, not at the bottom of a long form where
            what you are agreeing to has scrolled away — the reference puts it in the same place. */}
        {/* ⛔⛔ The gate intercepts the CLICK rather than disabling the button. A disabled
            control explains nothing — it just refuses, and the visitor is left guessing whether
            they filled the form wrong. The button still looks and behaves like the button; it
            says what is going on. `ready` is deliberately not required while gated, so someone
            who has typed nothing still gets the answer instead of an inert control. */}
        <button className="btn primary lg block" disabled={gated ? false : !ready}
                onClick={() => (gated ? setGateOpen(true) : create())}>
          {busy === 'create' ? 'Confirming' : 'Launch'}
        </button>
        {(!metaReady || !wallet.publicKey) && (
          <p className="side-note" style={{ textAlign: 'center', marginTop: 10 }}>
            {!wallet.publicKey ? 'Connect a wallet to launch.' : 'A name, a ticker and an image are all it takes.'}
          </p>
        )}

      </aside>
      </div>

      {/* ⛔⛔ The gate panel. Same scrim, same dialog shell and the same × as Buy with FOMO, so
          it is dismissed the way everything else on this site is dismissed: the close icon, the
          backdrop, or Escape. A modal you can only leave one way is a trap on a phone.

          ⚠ It says only what is true. Not "coming soon", not a date — the gate lifts when
          `FAMILY_CA` is set in family.js and nothing here knows when that will be. */}
      {gateOpen && (
        <div className="bwf-scrim" onClick={() => setGateOpen(false)} role="presentation">
          <div className="bwf gate-panel" role="dialog" aria-modal="true" aria-label="Launching is disabled"
               onClick={(e) => e.stopPropagation()}>
            <div className="bwf-head">
              <h2>Launching is disabled</h2>
              <button className="bwf-x" onClick={() => setGateOpen(false)} aria-label="Close">×</button>
            </div>
            <p className="gate-msg">Launching is currently disabled.</p>
          </div>
        </div>
      )}

      {error && <p className="note" style={{ marginTop: 18, color: 'var(--warn)' }}>{error}</p>}
      {/* ⭐ A DIALOG, not a line of text under a long form.
          The creator has just signed a transaction and the page is scrolled wherever they left
          it, so a note appended at the bottom is something they can miss entirely — and the one
          moment they must not miss is the one where it worked. It takes the same shell as the
          gate popup above, so there is one modal in this app rather than two that drift.
          ⚠ Dismissed by the ×, the scrim or Escape, and NOT by clicking the panel itself. */}
      {result && (
        <div className="bwf-scrim" onClick={() => setResult(null)} role="presentation">
          <div className="bwf launched-panel" role="dialog" aria-modal="true" aria-label="Token launched"
               onClick={(e) => e.stopPropagation()}>
            <div className="bwf-head">
              <h2>Token launched</h2>
              <button className="bwf-x" onClick={() => setResult(null)} aria-label="Close">×</button>
            </div>
            {/* The address it was given, click to copy — the same control every other surface
                uses for an address, so it behaves the way the rest of the site taught them. */}
            <CopyableAddress value={result.sale} />
            <a className="btn primary launched-go" href={`/sale/${result.sale}`}>View token</a>
          </div>
        </div>
      )}
    </section>
  )
}
