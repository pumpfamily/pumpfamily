import { useCallback, useEffect, useState } from 'react'
import { saleParam, queryOf, onRouteChange, navigate } from './router.js'
import { PublicKey } from '@solana/web3.js'
import {
  buildLaunchTx, buildRefundQuoteTx, buildSweepLamportsTx,
} from './program.mjs'
import { tokensOut, splitDeposit, RT0, walletHeadroom, MIN_DEPOSIT_FOR, MAX_WALLET_ALLOCATION, SUPPLY, solEquivalent, usdMarketCap, fmtUsdCap } from './curve.mjs'
import { Avatar, CopyableAddress, Socials, phaseOf, useTokenMeta } from './token.jsx'
import { loadSale, connectionFor } from './chain.js'
import { grindInBrowser } from './vanity.js'
import BuyWithFomo from './BuyWithFomo.jsx'
import Chart, { marketCap } from './Chart.jsx'
import { INDEXER_URL } from './Explore.jsx'

const toTok = (t) => Number(t) / 1e6

/**
 * A sale is denominated in SOL or in USDC, and every figure below is in that quote's own base
 * units — nine decimals or six. One place decides, so a number and its unit cannot disagree; the
 * bug this is written against is a lamport constant printed beside a six-decimal amount.
 */
const QUOTE_UNITS = {
  sol:  { label: 'SOL',  decimals: 9, step: '0.25' },
  usdc: { label: 'USDC', decimals: 6, step: '25' },
}
const unitsOf = (sale) => QUOTE_UNITS[sale?.quoteLabel] ?? QUOTE_UNITS.sol

/**
 * The shared lookup table a quote launch is sent with. ⛔ Deployment infrastructure: thirty-five
 * accounts do not fit in a legacy transaction, so without a table on chain the launch cannot be
 * built at all — and the page says so rather than offering a button that throws.
 */
const LAUNCH_LUT = import.meta.env.VITE_LAUNCH_LUT ?? ''
const fmt = (n, d = 0) => n.toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d })

/**
 * `skew` is how far the host clock runs ahead of the chain's — see `clockSkew` in chain.js. The
 * deadline being counted down to was written by the chain, so it has to be compared on the chain's
 * clock or the countdown disagrees with the program about whether the window is open.
 */
function Countdown({ to, skew = 0 }) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])
  const left = Math.max(0, Number(to) * 1000 - (now - skew * 1000))
  if (left === 0) return <span className="mono">closed</span>
  const s = Math.floor(left / 1000)
  const parts = [Math.floor(s / 86400), Math.floor(s / 3600) % 24, Math.floor(s / 60) % 60, s % 60]
  const label = parts[0] > 0 ? `${parts[0]}d ${parts[1]}h ${parts[2]}m` : `${parts[1]}h ${parts[2]}m ${parts[3]}s`
  return <span className="mono">{label}</span>
}

export default function Sale({ chain, wallet, undeployed = false }) {
  const [address, setAddress] = useState(saleParam)
  const [state, setState] = useState(null)
  const [amount, setAmount] = useState('0.25')
  // The Buy with FOMO popup. `?buy=1` on the URL opens it straight away, which is where the launch
  // cards on the home page send an open sale.
  const [buyOpen, setBuyOpen] = useState(() => queryOf('buy') === '1')
  const closeBuy = useCallback(() => setBuyOpen(false), [])
  const [busy, setBusy] = useState(null)
  const [msg, setMsg] = useState(null)
  /**
   * The price history behind the chart.
   *
   * Kept separate from `state` on purpose: it comes from the indexer, and the sale page has to
   * render without it. A missing history costs the chart and nothing else — every number the page
   * acts on still comes from the sale account.
   */
  const [history, setHistory] = useState(null)
  /**
   * What the indexer knows that the sale account cannot: where this coin's price lives NOW.
   *
   * ⛔ The sale account freezes at launch. Its `virtualSol` is the curve state the WINDOW ended on,
   * so reading a market cap off it after launch reports the launch price forever — and a coin that
   * has since migrated is priced by an AMM pool this page has no way to find on its own. The
   * indexer reads both and serves the answer; `null` means nothing could price it, which is shown
   * as unknown rather than as a number. See `market.mjs`.
   */
  const [market, setMarket] = useState(null)

  const refresh = useCallback(async (addr = address) => {
    if (!addr) return
    setMsg(null)
    /**
     * ⛔ The indexer's row is fetched FIRST and handed to `loadSale` as a fallback. An RPC that
     * answered null for an account that exists used to make this page deny a live sale outright.
     */
    let indexed = null
    try {
      const r = await fetch(`${INDEXER_URL}/api/sales/${addr}`)
      if (r.ok) indexed = await r.json()
    } catch { indexed = null }
    try { setState(await loadSale(connectionFor(chain), addr, wallet.publicKey, indexed)) }
    catch (e) { setState({ error: e.message }) }
    try {
      const r = await fetch(`${INDEXER_URL}/api/sales/${addr}/history`)
      setHistory(r.ok ? (await r.json()).deposits : [])
    } catch { setHistory(null) }   // null means "no chart", never "no deposits"
    try {
      const r = await fetch(`${INDEXER_URL}/api/sales/${addr}`)
      setMarket(r.ok ? await r.json() : null)
    } catch { setMarket(null) }
  }, [address, chain, wallet.publicKey])

  useEffect(() => { if (address) refresh(address) }, [chain, wallet.publicKey])  // eslint-disable-line

  // Following a link from one sale to another changes only the path, which does not remount this
  // page — so without this the second sale's URL kept showing the first sale.
  useEffect(() => onRouteChange(() => {
    const next = saleParam()
    if (next && next !== address) { setAddress(next); setState(null); setHistory(null); setMarket(null); refresh(next) }
  }), [address, refresh])

  /**
   * A sensible default amount for the denomination, once the sale has loaded and said what it is.
   * 0.25 is a reasonable SOL deposit and below the 2 USDC floor, so leaving it would greet every
   * USDC sale with an error the visitor did not cause.
   */
  const quoteLabel = state?.sale?.quoteLabel
  useEffect(() => {
    if (quoteLabel) setAmount((QUOTE_UNITS[quoteLabel] ?? QUOTE_UNITS.sol).step)
  }, [quoteLabel])

  // Every action goes through a `build*Tx` helper in program.mjs rather than assembling
  // instructions here, because a transaction built inside a click handler cannot be tested without
  // a wallet. browser-tx.test.mjs drives these same builders and proves the bytes land.
  const send = async (label, build) => {
    setBusy(label); setMsg(null)
    try {
      const tx = await build(connectionFor(chain), new PublicKey(wallet.publicKey))
      const sig = await wallet.signAndSend(tx)
      setMsg({ ok: true, text: `Sent. ${sig.slice(0, 20)}…` })
      setTimeout(() => refresh(), 1500)
    } catch (e) {
      setMsg({ ok: false, text: e.message ?? String(e) })
    } finally { setBusy(null) }
  }

  const s = state?.sale
  // The chain's clock, not the host's — see `clockSkew` in chain.js. Every deadline on a sale was
  // written by the program, and only the program's clock decides whether it has passed.
  const chainNow = Math.floor(Date.now() / 1000) - (state?.skew ?? 0)
  // Resolved in the browser rather than read from the indexer: this page is the surface people
  // reach by shared link, and it has to render with the indexer down. See useTokenImage.
  const browserMeta = useTokenMeta(s?.uri)
  /**
   * ⛔⛔ The indexer's image wins.
   *
   * It resolved this coin's metadata server-side, walking several IPFS gateways with retries —
   * work this page then threw away by re-fetching the URI from the visitor's browser, which walks
   * nothing. So a coin whose picture the server had resolved perfectly rendered here as a grey
   * circle with a letter in it, and every visitor paid an IPFS round trip to get that.
   *
   * ⚠ The browser's own fetch stays as the fallback: the indexer may not have reached this sale
   * yet, and `description` and the socials only come from there.
   */
  const meta = {
    ...browserMeta,
    image: market?.image ?? browserMeta.image,
    description: browserMeta.description ?? market?.description ?? null,
    twitter: browserMeta.twitter ?? market?.twitter ?? null,
    telegram: browserMeta.telegram ?? market?.telegram ?? null,
    website: browserMeta.website ?? market?.website ?? null,
  }

  /**
   * The sale's phase, derived exactly as the indexer derives it for the listing.
   *
   * `status` alone is not it. A sale stays `Open` on chain from the moment it is created until
   * someone launches it, so gating the deposit box on `status === 0` kept offering deposits after
   * the window had shut — the program would then reject them with `WindowClosed`, after the
   * depositor had signed and paid a fee.
   */
  const phase = s ? phaseOf(s, chainNow) : null

  // The sale's denomination, and the two things every figure below needs from it.
  const q = unitsOf(s)
  const isQuote = !!s && s.quoteLabel !== 'sol'
  const scale = 10 ** q.decimals
  const toQuote = (v) => Number(v) / scale
  const quoteMint = s?.quoteMint ?? null

  /**
   * What this buy gets, in the two steps the program takes: USDC → lamports at the swap pool's
   * spot, then lamports → tokens on the SOL curve.
   *
   * ⚠ An ESTIMATE, and the page says so. The tokens are final only at launch, when the raise is
   * swapped for real and every allocation is scaled by what it actually bought — one factor for
   * everyone. ⛔ Without the pool's reserves there is no honest quote, so there is none.
   */
  const reserves = state?.reserves ?? null
  let preview = null
  if (phase === 'open' && reserves) {
    const units = BigInt(Math.round((parseFloat(amount) || 0) * scale))
    if (units > 0n) {
      try {
        const lamports = solEquivalent(units, reserves.sol, reserves.usdc)
        const { curveIn } = splitDeposit(lamports, s.protocolFeeBps, s.creatorFeeBps)
        const out = tokensOut(s.virtualSol, s.virtualToken, curveIn, RT0 - s.sold)
        const priceNow = Number(s.virtualSol) / Number(s.virtualToken)
        preview = { out, value: Number(out) * priceNow, units, lamports }
      } catch { preview = null }
    }
  }

  /*
   * The same two rules the program enforces, checked here first.
   *
   * Not a substitute for the on-chain check — the chain is the authority and this cannot be
   * trusted — but a deposit that is going to be rejected should be refused before a wallet asks
   * someone to sign it. A signed transaction that reverts still costs a fee and reads, to whoever
   * signed it, like the site is broken.
   *
   * The headroom is computed from the sale account's live curve state rather than by replaying
   * deposits, so it is correct even for a wallet that has never touched this page before.
   */
  let limit = null
  /**
   * ⛔⛔ Not when the row came from the index. A quote is arithmetic on the sale's LIVE curve
   * state, and a cached row has none — `walletHeadroom` on zeroed reserves threw
   * "Cannot mix BigInt and other types" and took the whole page down with it.
   *
   * ⚠ Nothing is lost: buying is already withheld on a stale row, so there was never a quote to
   * act on. The page shows the coin and says why it cannot transact.
   */
  if (phase === 'open' && !state.stale) {
    const held = state.position ? state.position.allocation : 0n
    // ⚠ The sale's own denomination. Without it the quoted maximum is measured against a lamport
    // floor, and a USDC sale reports "nothing fits" while 2-10 USDC deposits are still legal.
    // ⛔ 'sol': the curve is the SOL curve, so the headroom comes back in LAMPORTS. It is
    // converted to USDC where it is shown, because that is what the buyer is about to send.
    const room = walletHeadroom(s.virtualSol, s.virtualToken, s.sold, held,
                                s.protocolFeeBps, s.creatorFeeBps, 'sol')
    limit = {
      held,
      heldPct: Number(held * 10_000n / SUPPLY) / 100,
      // null means the curve runs out before the ceiling does.
      headroom: room,
      atCeiling: room === 0n,
      // `room` is 0 for two different reasons and a depositor deserves the right one: actually at
      // 3% of supply, or short of it by less than the minimum deposit is worth.
      wedged: room === 0n && held < MAX_WALLET_ALLOCATION,
    }
  }

  const wanted = BigInt(Math.round((parseFloat(amount) || 0) * scale))
  // ⚠ Per denomination. The floor is 0.01 SOL or 2 USDC, and the bare lamport constant read as a
  // 10 USDC floor — the browser would have refused deposits the program accepts.
  const floor = MIN_DEPOSIT_FOR[s?.quoteLabel] ?? MIN_DEPOSIT_FOR.sol
  const depositError = (() => {
    if (phase !== 'open' || !amount) return null
    if (undeployed) return 'This build is reading a cluster the program is not on. See the note above.'
    if (!(parseFloat(amount) > 0)) return 'Enter an amount.'
    if (wanted < floor) return `The minimum buy is ${fmt(toQuote(floor), q.decimals === 6 ? 2 : 3)} ${q.label}.`
    // ⛔ Everything below this line compares LAMPORTS, because the curve does. What the buyer
    // typed is USDC, so it is converted once, here, at the same pool rate the program will use.
    if (!reserves) return 'The swap pool cannot be read right now, so this buy cannot be priced.'
    const wantedSol = solEquivalent(wanted, reserves.sol, reserves.usdc)
    const asUsdc = (lamports) => Number((lamports * reserves.usdc) / reserves.sol) / 1e6
    if (limit?.atCeiling) return 'This wallet already holds the most any one wallet may hold: 3% of supply.'
    if (limit?.headroom !== null && limit?.headroom !== undefined && wantedSol > limit.headroom) {
      return `That would put this wallet over 3% of supply. The most it can add now is about ${fmt(asUsdc(limit.headroom), 2)} USDC.`
    }
    if (wantedSol > s.perWalletCap - (state.position?.solEquiv ?? 0n)) {
      return 'That is more than this sale allows one wallet to put in.'
    }
    return null
  })()

  return (
    <section className="page">
      {/* Reached from a link, the page is about that sale: a way back, not an address box. The box
          is only for someone who arrived with nothing loaded. */}
      {s ? (
        <a className="back-link" href="/explore">← All launches</a>
      ) : (
      <div className="sim" style={{ marginBottom: 22 }}>
        <div className="sim-head">
          <div style={{ flex: 1, minWidth: 240 }}>
            <h2>Find a sale</h2>
            <p>Paste a sale address.</p>
          </div>
          <div style={{ display: 'flex', gap: 8, flex: 2, minWidth: 300 }}>
            <input className="field mono" placeholder="Sale address" value={address}
                   onChange={(e) => setAddress(e.target.value.trim())} />
            {/* The URL follows what is loaded, so a sale found by pasting is a sale that can be
                shared — which the hash build could not do from this box either. */}
            <button className="btn" onClick={() => { if (address) navigate(`/sale/${address}`); refresh() }}>Load</button>
          </div>
        </div>
      </div>
      )}

      {state?.error && <p className="note" style={{ color: 'var(--warn)' }}>{state.error}</p>}
      {/* ⛔ Said, not hidden. The page is showing what the INDEX last knew, because the chain read
          came back empty for an address the index has seen. Every action is withheld above. */}
      {state?.stale && (
        <p className="note" style={{ color: 'var(--warn)', marginBottom: 16 }}>
          Showing this sale from the launch index &mdash; its live on-chain state could not be read
          just now, so buying, launching and refunding are unavailable until it can.
        </p>
      )}

      {s && (
        <>
          <div className="sim" style={{ marginBottom: 22 }}>
            {/* ⭐ Laid out like the token page: the coin centred on the page's axis, big enough
                to be the subject, with the figures underneath. It used to be a 44px avatar and a
                heading squeezed against a countdown on the far right, which read as a table row
                that had escaped its table. */}
            <div className="sim-body tok-page">
              <Avatar image={meta.image} symbol={s.symbol} size={72} />
              <h1 className="tok-page-h">{s.symbol}</h1>
              <p className="tok-page-sub">{s.name}</p>
              {/* ⛔ No phase pill. The card below already says what state the sale is in, in a
                  full sentence, and the window line under this says whether it is open — a chip
                  repeating one of them in a third wording added nothing.
                  ⚠ The paragraph renders only when there is something in it: an empty <p> here
                  left a gap that read as a missing element. */}
              {(meta.twitter || meta.telegram || meta.website) && (
                <p style={{ margin: '12px 0 0' }}>
                  <Socials twitter={meta.twitter} telegram={meta.telegram} website={meta.website} />
                </p>
              )}
              {meta.description && <p className="tok-page-note">{meta.description}</p>}

              {market?.marketCap != null && (
                <p className="tok-page-cap">
                  <strong className="mono">
                    {market.solUsd ? fmtUsdCap(usdMarketCap(market.marketCap, market.solUsd)) : `${fmt(market.marketCap, 0)} SOL`}
                  </strong> <span className="dim">MC</span>
                </p>
              )}

              {!state.mint.equals(PublicKey.default) && <CopyableAddress value={state.mint.toBase58()} />}

              {/* The countdown is the one thing a sale has that a token does not, so it sits
                  under the identity rather than opposite it. */}
              <p className="mono tok-page-window">
                <span className="flat">{phase === 'open' ? 'FOMO window closes in ' : 'FOMO window '}</span>
                {phase === 'open' ? <Countdown to={s.windowEnd} skew={state.skew ?? 0} /> : 'closed'}
              </p>
              {/* Before launch too: a buyer should know what the coin will trade against. */}
              {phase === 'open' && market?.pair && (
                <p className="mono tok-page-window">
                  <span className="flat">Launches paired with </span>{market.pair.symbol ?? `${market.pair.mint.slice(0, 4)}…${market.pair.mint.slice(-4)}`}
                </p>
              )}
            </div>
            <div className="sim-body">
              <div className="facts" style={{ marginBottom: 0 }}>
                {/* ⛔ Two units on one row, and they are not interchangeable: `gross` is the USDC
                    buyers sent, while the caps are the SOL curve's — the raise is swapped when the
                    window shuts. Labelling both with `q.label` printed lamport caps as USDC. */}
                {/* ⛔ SOL, not the pay unit. Buyers send USDC, but the coin's curve is the SOL
                    curve, so the pool is stated in the unit it will actually be.

                    ⛔⛔ Three sources, in this order, and the order is the whole point:
                      1. `solIn`       — what the swap at the close REALLY returned. Fact.
                      2. `solExpected` — the program's OWN running total, each deposit booked at
                                         the pool's rate at the time. Fact, just earlier.
                      3. `gross` at spot — an ESTIMATE, and marked `~` because it is one. A spot
                                         rate applied now is a different, later number than what
                                         the raise was actually booked at.
                    Only reached when 1 and 2 are both zero, which means the chain read failed and
                    we are on the indexed row, or the sale predates the column. Printing a bare
                    `0.000 SOL` there was the bug: a sale holding real money claiming it held none.
                    An estimate says the right thing; a confident zero says a false one. */}
                <div className="fact">
                  <div className="k">Pool</div>
                  <div className="v">{phase === 'failed' ? 'refunded' : (() => {
                    const known = s.solIn > 0n ? s.solIn : s.solExpected
                    if (known > 0n) return `${fmt(Number(known) / 1e9, 3)} SOL`
                    // ⚠ `gross` is USDC base units (6dp) and `solUsd` is dollars per SOL. Guard
                    // the divide: an unread price is null, and null is not zero.
                    const usd = Number(s.gross ?? 0n) / 1e6
                    if (usd > 0 && market?.solUsd > 0) return `~${fmt(usd / market.solUsd, 3)} SOL`
                    return usd > 0 ? `${fmt(usd, 2)} USDC` : '0.000 SOL'
                  })()}</div>
                </div>
                <div className="fact"><div className="k">Per wallet</div><div className="v">3% of supply</div></div>
                <div className="fact"><div className="k">Tokens Sold</div><div className="v">{fmt(toTok(s.sold))}</div></div>
              </div>
            </div>
          </div>

          {phase === 'open' && (
            <div className="sim buy-cta" style={{ marginBottom: 22 }}>
              <div className="sim-body">
                <div className="buy-cta-row">
                  <div>
                    <h2>Buy with FOMO</h2>
                    <p>Only FOMO users can buy until the window closes.</p>
                  </div>
                  <button className="btn primary lg" disabled={state.stale} onClick={() => setBuyOpen(true)}>Buy with FOMO</button>
                </div>
              </div>
            </div>
          )}


          {phase === 'awaiting-launch' && (
            <div className="sim launch-cta" style={{ marginBottom: 22 }}>
              <div className="sim-body">
                <h2 style={{ margin: '0 0 6px', fontSize: 19 }}>The window has closed. Launching now.</h2>
                <p className="note" style={{ margin: '0 0 16px' }}>
                  The coin is created on pump.fun and the pooled {q.label} buys the curve in one transaction,
                  then every buyer's tokens are sent to them. It happens automatically within a few minutes.
                  <strong> Anyone can also send it</strong>, whether they bought or not, so nobody can sit on
                  the money.
                </p>
                <button className="btn primary" disabled={state.stale || !wallet.publicKey || busy || undeployed || (isQuote && !LAUNCH_LUT)}
                        onClick={() => send('launch', async (conn, payer) => {
                          // The coin's address is picked now, from a random nonce, so it cannot be
                          // known (and blocked) before this transaction lands.
                          const { nonce } = await grindInBrowser(state.address.toBase58())
                          // ⛔ The raise has to be swapped to SOL before this can land — the
                          // watcher cranks that, and the program refuses a launch without it.
                          return buildLaunchTx(conn, payer, state.address, state.vault, nonce,
                                               s.creatorFeeRecipient, LAUNCH_LUT)
                        })}>
                  {busy === 'launch' ? 'Finding the address and confirming' : 'Launch it'}
                </button>
                {!wallet.publicKey && <span className="note" style={{ marginLeft: 12 }}>Connect a wallet to send it.</span>}
                {/* Said plainly rather than left to fail on click: a quote launch is thirty-five
                    accounts, which a legacy transaction cannot carry, so it needs the shared
                    lookup table to exist on this cluster. */}
                {isQuote && !LAUNCH_LUT && (
                  <p className="note warn" style={{ marginTop: 12, marginBottom: 0 }}>
                    A {q.label} launch has to be sent with the shared address lookup table, and none is
                    configured for this deployment. The sale is safe — it can still be failed and refunded —
                    but it cannot be launched from here until one is.
                  </p>
                )}
              </div>
            </div>
          )}

          {phase === 'failing' && (
            <div className="sim" style={{ marginBottom: 22 }}>
              <div className="sim-body">
                <h2 style={{ margin: '0 0 6px', fontSize: 19 }}>The window closed below its minimum</h2>
                <p className="note" style={{ margin: 0 }}>
                  It needed {fmt(toQuote(s.minRaise), 2)} {q.label} and raised {fmt(toQuote(s.gross), 2)}, so the coin will not
                  be created. Every buy is being sent back in full to the wallet it came from, automatically.
                </p>
              </div>
            </div>
          )}

          {phase === 'launched' && (
            <div className="sim" style={{ marginBottom: 22 }}>
              {/* ⭐ Centred, like every other card on this page. It was left-aligned prose with a
                  hanging rule and two buttons trailing off to one side, which read as the end of
                  a form rather than the end of a story. */}
              <div className="sim-body launched-card">
                <h2>{market?.marketState === 'migrated' ? 'Migrated off the bonding curve' : 'Launched on pump.fun'}</h2>
                {/* ⛔ No address here. The header carries it, in the same control — printing it
                    twice on one page is two things to keep in step for no gain. */}
                {/* ⭐ Where this coin's creator fee goes. It is a fact about the coin that a
                    buyer cannot read anywhere else on the page, and it is permanent: pump.fun
                    takes `is_holder_reward` at creation and offers no way to change it after.
                    ⛔ `null` means the indexer has no answer for this sale — say nothing rather
                    than print the default, which would be a claim we did not check. */}
                {market?.holderRewards != null && (
                  <p className="launched-fees">
                    Creator fees go to <strong>{market.holderRewards ? 'the coin\u2019s holders' : 'the creator'}</strong>
                  </p>
                )}
                {/* ⭐ A custom pair: what the coin trades against on pump.fun. Absent for SOL. */}
                {market?.pair && (
                  <p className="launched-fees">
                    Paired with <strong>{market.pair.symbol ?? `${market.pair.mint.slice(0, 4)}…${market.pair.mint.slice(-4)}`}</strong>
                  </p>
                )}
                <div className="launched-actions">
                  <a className="btn primary" href={`https://pump.fun/coin/${state.mint}`} target="_blank" rel="noreferrer">Trade on pump.fun</a>
                  <a className="btn" href="https://fomo.family" target="_blank" rel="noreferrer">Open FOMO</a>
                </div>
              </div>
            </div>
          )}

          {phase === 'failed' && (
            <div className="sim" style={{ marginBottom: 22 }}>
              <div className="sim-body">
                <h2 style={{ margin: '0 0 6px', fontSize: 19 }}>This sale did not launch</h2>
                {s.solIn > 0n ? (
                  <p className="note" style={{ margin: 0 }}>
                    The raise had already been swapped to SOL when the launch deadline passed, so the coin was
                    never created. Each buyer is sent their share of that SOL, in proportion to what they put in.
                  </p>
                ) : (
                  <p className="note" style={{ margin: 0 }}>
                    It missed its minimum raise of {fmt(toQuote(s.minRaise), 2)} {q.label}, so the coin was never
                    created. Every buy is sent back in full to the wallet it came from.
                  </p>
                )}
              </div>
            </div>
          )}

          {phase === 'expired' && (
            <div className="sim" style={{ marginBottom: 22 }}>
              <div className="sim-body">
                <h2 style={{ margin: '0 0 6px', fontSize: 19 }}>Nobody launched in time</h2>
                <p className="note" style={{ margin: 0 }}>
                  The launch window passed without anyone triggering it, so this sale can be failed and
                  every buy refunded in full.
                </p>
              </div>
            </div>
          )}

          <BuyWithFomo
            open={buyOpen && phase === 'open'}
            onClose={closeBuy}
            saleAddress={state?.address?.toBase58?.() ?? address}
            depositAddress={s?.depositWallet?.toBase58?.() ?? ''}
            symbol={s?.symbol ?? ''}
            amount={amount}
            setAmount={setAmount}
            receive={preview && !depositError ? Number(preview.out) / 1e6 : null}
            error={depositError}
            minBuy={2}
          />

          {/* The chart needs at least one deposit to be a chart. Before that the page already says
              the window is open and nothing has come in, which is the same information. */}
          {history?.length > 0 && (
            <div style={{ marginBottom: 22 }}>
              {/* ⛔ The live cap when the indexer has one, the sale's own curve only while the
                  window is open. After launch `s.virtualSol` is frozen at the closing price. */}
              {/* ⛔⛔ `'sol'`, NOT `s.quoteLabel`. The coin's curve is the SOL curve; `quoteLabel`
                  is what buyers PAY IN, which is USDC. Passing it here priced a 32-SOL curve at
                  223,049 — the chart's own `curveQuote` was already right, so the headline figure
                  disagreed with every point under it and with the Explore row for the same coin. */}
              <Chart deposits={history} symbol={s.symbol} payQuote={s.quoteLabel} curveQuote="sol"
                     solUsd={market?.solUsd ?? null}
                     nowMarketCap={market?.marketCap ?? marketCap(s.virtualSol, 'sol')} />
{/* ⛔ The per-buy table is gone at the operator's request. `ChartTable` is still
                  exported from Chart.jsx if it is ever wanted back. */}
            </div>
          )}

          {/* ⭐ The creator's own change, back in one click.
              The creator prefunds 0.045 SOL when they open a sale so a permissionless cranker
              never pays for the launch, and a `create_v2` launch spends about 0.0072 of it. The
              rest used to come back only by running a command — which meant in practice it did
              not come back. ⛔ Only shown to the sale's AUTHORITY, and only once the program
              would actually allow it: launched, or failed with nothing still owed. */}
          {wallet.publicKey && s.authority.toBase58() === wallet.publicKey
            && (s.status === 1 || (s.status === 2 && s.gross === 0n))
            /* ⛔ Only when there is something above the rent floor the vault must keep. Offering
               this on an already-swept sale is a button whose only outcome is `NothingToSweep`.
               `null` means the balance could not be read, which is not a reason to offer it. */
            && (state.sweepable ?? 0) > 0 && (
            <div className="sim" style={{ marginBottom: 22 }}>
              <div className="sim-head center"><div><h2>Your launch reserve</h2></div></div>
              <div className="sim-body" style={{ textAlign: 'center' }}>
                <p className="note note-center">
                  You prefunded this sale so that launching it never cost anyone else anything.
                  Whatever the launch did not spend is yours to take back.
                </p>
                <p className="mono" style={{ fontSize: 22, margin: '14px 0 0' }}>
                  {fmt(state.sweepable / 1e9, 4)} SOL
                </p>
                <button className="btn" style={{ marginTop: 16 }} disabled={state.stale || busy}
                        onClick={() => send('sweep', (conn, payer) =>
                          buildSweepLamportsTx(conn, payer, state.address, state.vault))}>
                  {busy === 'sweep' ? 'Confirming' : 'Reclaim it'}
                </button>
              </div>
            </div>
          )}

          {/* ⭐ Centred, like the cards on Launch. It was a left-aligned heading over a single
              short line of text, which left the card reading as an empty shelf. */}
          <div className="sim">
            <div className="sim-head center"><div><h2>Your position</h2></div></div>
            <div className="sim-body">
              {!state.position && (
                <p className="flat position-empty">
                  {wallet.publicKey
                    ? 'This wallet has not bought into this sale.'
                    : <>Bought from FOMO? Check it on <a href="/portfolio">Your positions</a> with your FOMO wallet address.</>}
                </p>
              )}
              {state.position && (
                <>
                  <table className="q" style={{ marginBottom: 16 }}>
                    <tbody>
                      <tr><td>Deposited</td><td className="num">{fmt(toQuote(state.position.deposited), 4)} {q.label}</td></tr>
                      {/* Once it has launched this is what was DELIVERED — the quoted allocation
                          scaled by what the raise actually bought. Before that, the quote. */}
                      <tr><td>{s.status === 1 ? 'Delivered' : 'Allocation'}</td><td className="num">
                        {fmt(toTok(s.status === 1 && s.sold > 0n
                          ? (state.position.allocation * s.tokensReceived) / s.sold
                          : state.position.allocation))} {s.symbol}</td></tr>
                      <tr><td>Settled</td><td className="num">{state.position.claimed ? 'yes' : 'no'}</td></tr>
                    </tbody>
                  </table>
                  {/* ⛔ No claim button, and not because it was forgotten. Tokens are PUSHED to
                      the wallet that paid — a FOMO buyer cannot sign anything here — and the old
                      one built a Token-2022 transaction, which a v1 SOL coin is not. A button
                      that cannot work is worse than no button. */}
                  {s.status === 1 && !state.position.claimed && (
                    <p className="note" style={{ marginTop: 12 }}>
                      Your tokens are on their way to the wallet you paid from. Nobody has to claim.
                    </p>
                  )}
                  {s.status === 2 && !state.position.claimed && (
                    <button className="btn primary" disabled={state.stale || busy || undeployed}
                            onClick={() => send('refund', (conn, payer) => (isQuote
                              ? buildRefundQuoteTx(conn, payer, state.address, state.vault, quoteMint, s.depositAccount)
                              : Promise.reject(new Error('Only USDC sales exist.'))))}>
                      {busy === 'refund' ? 'Confirming' : 'Refund'}</button>
                  )}
                </>
              )}
            </div>
          </div>
        </>
      )}

      {msg && <p className="note" style={{ marginTop: 18, color: msg.ok ? 'var(--accent)' : 'var(--warn)' }}>{msg.text}</p>}
    </section>
  )
}
