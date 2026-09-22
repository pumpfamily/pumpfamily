import { useEffect, useRef, useState } from 'react'
import { FAMILY, FAMILY_CA, familyIsLive } from './family.js'
import { CopyableAddress, TokenCard } from './token.jsx'
import { routeOf, onRouteChange, interceptLinks, upgradeHashUrl, tokenParam } from './router.js'
import Sale from './Sale.jsx'
import Create from './Create.jsx'
import Explore, { INDEXER_URL } from './Explore.jsx'
import Portfolio from './Portfolio.jsx'
import MyTokens from './MyTokens.jsx'
import FamilyToken from './FamilyToken.jsx'
/** Served from public/ at the root. Importing it out of public/ is what Vite warns about. */
const logo = '/logo.png'
import { useWallet } from './wallet.js'
import { connectionFor, programDeployed } from './chain.js'
import { PROGRAM_ID } from './program.mjs'

// A sale's `gross` is USDC in base units: a send from the FOMO app moves USDC.
const fmt = (n, d = 0) => n.toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d })

const CHAIN = import.meta.env.VITE_CHAIN ?? 'solana:localnet'

/**
 * Pump Family's own token, on the front page.
 *
 * ⛔⛔ Two states and no third. With no address it says the ticker and that the address is coming;
 * with one it shows the address, copyable, linking to the coin's page. There is no "soon", no
 * countdown and no placeholder that could be mistaken for a real contract — the single worst
 * outcome here is somebody copying an address that is not ours.
 */
function FamilyStrip() {
  const live = familyIsLive()
  return (
    <div className="fam-strip">
      <img className="fam-mark" src={FAMILY.image} alt={`${FAMILY.name} (${FAMILY.symbol})`} width="34" height="34" />
      {live ? (
        /* The same control the token and sale pages use: the address in full, copied by clicking
           it. ⛔ One implementation — three copies of a clipboard handler is three places for the
           failure path to be forgotten. */
        <CopyableAddress value={FAMILY_CA} className="fam-ca-btn" />
      ) : (
        <span className="fam-soon">contract address coming</span>
      )}
    </div>
  )
}

/**
 * X and GitHub, as one pair.
 *
 * ⚠ Defined once and rendered in the HEADER. It used to live in the footer, which meant a visitor
 * had to reach the bottom of a long page to find either.
 */
function SocialLinks() {
  return (
    <>
      <a className="pf-x" href="https://x.com/pumpdotfamily" target="_blank" rel="noreferrer"
         aria-label="Pump Family on X">
        {/* Inline rather than a font or an image: one shape, no request, and it inherits colour. */}
        <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" focusable="false">
          <path fill="currentColor" d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
        </svg>
      </a>
      <a className="pf-x" href="https://github.com/pumpfamily/pumpfamily" target="_blank" rel="noreferrer"
         aria-label="Pump Family on GitHub">
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
          <path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
        </svg>
      </a>
    </>
  )
}

/*
 * The wallet list lives behind one button rather than sitting inline.
 *
 * Rendering every detected wallet in the header looks fine with one installed and breaks the
 * layout with five: the row overflows and lands on top of the nav. Still enumerate-and-choose,
 * just not at the cost of the header.
 */
function WalletBar({ wallet }) {
  const [open, setOpen] = useState(false)
  /**
   * Closes on a press OUTSIDE the menu, measured against the menu's own box.
   *
   * ⛔⛔ It used to close on ANY click and the menu defended itself with
   * `onClick={(e) => e.stopPropagation()}` on its container. That worked for the menu and broke
   * the two links inside it: `interceptLinks()` listens on `document`, so a click that never
   * bubbles that far is never turned into a route change. `My tokens` and `Your positions` did a
   * FULL PAGE LOAD, React remounted, and the wallet — which lives in a hook — came back empty.
   * The visible symptom was being disconnected by opening your own tokens.
   *
   * ⚠ `mousedown`, not `click`: the effect that adds this listener is flushed while the opening
   * click is still propagating, so a `click` listener would catch the very press that opened the
   * menu and shut it again.
   */
  const menuRef = useRef(null)
  useEffect(() => {
    if (!open) return
    const close = (e) => { if (!menuRef.current?.contains(e.target)) setOpen(false) }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [open])

  if (wallet.publicKey) {
    return (
      <div className="walletmenu" ref={menuRef}>
        <button className="btn wallet-id" onClick={() => setOpen((v) => !v)}>
          <span className="mono">{wallet.publicKey.slice(0, 4)}…{wallet.publicKey.slice(-4)}</span>
          <span className="caret" aria-hidden="true">▾</span>
        </button>
        {open && (
          <div className="walletlist">
            <a href="/mytokens" onClick={() => setOpen(false)}>My tokens</a>
            <a href="/portfolio" onClick={() => setOpen(false)}>Your positions</a>
            <button className="danger" onClick={() => { setOpen(false); wallet.disconnect() }}>Disconnect</button>
          </div>
        )}
      </div>
    )
  }
  if (!wallet.available.length) return <span className="flat" style={{ fontSize: 13 }}>No wallet detected</span>

  /**
   * ⛔ A wallet's approval window can open behind the browser, or not at all if the extension is
   * locked, and `connect()` then simply never settles — so waiting is still SAID, on the button
   * itself. The explanatory panel that used to drop under it is gone at the operator's request:
   * the label carries it, and `useWallet` gives up on its own so the button cannot stick.
   */
  if (wallet.connecting) {
    return (
      <div className="walletmenu" ref={menuRef}>
        <button className="btn" disabled>Connecting to {wallet.connecting.name}…</button>
      </div>
    )
  }

  return (
    <div className="walletmenu" ref={menuRef}>
      {/* The count of detected wallets used to sit here. It read as a notification badge and told
          the visitor nothing they act on — the list below names every wallet anyway. */}
      <button className="btn" onClick={() => setOpen((v) => !v)}>Connect wallet</button>
      {open && (
        <div className="walletlist">
          {wallet.available.map((w) => (
            <button key={w.name} onClick={() => { setOpen(false); wallet.connect(w) }}>
              {w.icon && <img src={w.icon} alt="" />}{w.name}
            </button>
          ))}
          {/* ⛔ The refusal belongs where the click was. It used to print in the FOOTER, a page
              away from the button that caused it, which is the same as not showing it. */}
          {wallet.error && <p className="walletwarn">{wallet.error}</p>}
        </div>
      )}
    </div>
  )
}

/**
 * Everything that explains the mechanic, on its own route.
 *
 * ⛔ The pricing SIMULATOR that used to live here — two sliders, a queue table and a chart of what
 * each position pays — was removed on the operator's instruction, along with the stat strip, when
 * this copy replaced it. It is in git (`App.jsx` before 20 Sep 2026) with `simulate()` intact if
 * it is ever wanted back.
 *
 * The page is prose now, and its shape is the site's own: the numbered `.step` rows the home page
 * uses, then cards, so this reads as part of the product rather than a document dropped into it.
 */
function HowBody() {
  return (
    <div className="page">
      {/* ⭐ Centred, and given a MEASURE rather than the 30ch the statement carries elsewhere: at
          that width the opening line broke after "starts with a", which reads as a mistake. The
          statement balances its lines, the body runs to 66ch, and both sit on the page's axis.
          ⛔ No eyebrow above the title here: it read "How it works" directly over a title that
          now says the same thing. */}
      <div className="pf-head center how-hero">
        <h1>How it works</h1>
      </div>

      <div className="how-intro">
        <p className="ed-statement">
          Every token starts on FOMO
        </p>
        <p className="how-lede">
          During the FOMO window all first buys happen through the FOMO, when the window ends the
          token launches on Pump.fun and trading begins on the bonding curve.
        </p>
      </div>

      <div className="steps how-steps">
        {[
          {
            n: '01',
            title: 'Launch your token',
            body: [
              'Launch from any Solana wallet and choose your token name, logo and FOMO window.',
              'You decide how long the FOMO phase stays open. The token itself is not created until the window ends.',
            ],
          },
          {
            n: '02',
            title: 'FOMO window',
            body: [
              'Every buy is signed by FOMO and added to the launch in order. Other wallets cannot enter during the FOMO window.',
              'Your position in the queue determines your price.',
            ],
          },
          {
            n: '03',
            title: 'Earlier entries get better pricing',
            body: [
              'FOMO uses the same pricing curve that the token will trade on after launch.',
              'The earlier you enter the window the lower your position on the curve. Later buyers enter at higher prices.',
            ],
          },
          {
            n: '04',
            title: 'The token launches on Pump.fun',
            body: [
              'When the FOMO window closes the token is created and the pooled USDC is used to enter the Pump.fun bonding curve.',
              'The tokens are automatically distributed to the FOMO buyers.',
            ],
          },
        ].map((s) => (
          <div className="step" key={s.n}>
            <div className="step-n">{s.n}</div>
            <h3>{s.title}</h3>
            <div className="step-body">
              {s.body.map((line, i) => <p key={i}>{line}</p>)}
            </div>
          </div>
        ))}
      </div>

      <section className="how-band">
        <h2>No dev buy. No bot in front of you.</h2>
        <p>
          The coin does not exist until the window closes, so nothing can buy it before the people
          in the window did. The creator has no early allocation. Every entry is priced by its place
          in the queue, on the same curve the coin trades on afterwards.
        </p>
        <p>
          What this does not do: it cannot stop one person entering from several FOMO wallets, and
          the 3% per-wallet cap is measured on what a wallet sends, before the swap at the close
          scales every position by the same factor.
        </p>
      </section>

      <section className="how-band trust-band">
        <h2>What you are trusting</h2>
        <p>
          The program bounds the money. Two things sit outside it, stated here rather than hidden:
        </p>
        <p>
          A watcher we run decides which transfers came from FOMO. It cannot take credited money
          or credit money that never arrived, but a stolen key could misattribute a send. Its
          every decision names the transfer, so anyone can check it against the chain.
        </p>
        <p>
          The program can still be upgraded by a single wallet, with no multisig or timelock. The
          source is public, the deployed bytes can be compared to a build with one command, and
          there has been no independent audit. Read the README before you send anything.
        </p>
      </section>


    </div>
  )
}

/**
 * A launch as a card, the way ponscharity.family shows one: the image on top, the ticker in mono,
 * the name, one big figure with a small-caps label, then a hairline and the status.
 */
/** Sales and stats from the indexer, refreshed while the page is open. Null until the first answer. */
function useLaunchData() {
  const [data, setData] = useState(null)
  useEffect(() => {
    let dead = false
    const load = async () => {
      try {
        const [a, b, c] = await Promise.all(['sales', 'stats', 'health'].map((k) => fetch(`${INDEXER_URL}/api/${k}`).then((r) => r.json())))
        if (!dead) setData({ sales: a.sales ?? [], stats: b, chainTime: c.chainTime, solUsd: a.solUsd ?? null, at: Date.now() })
      } catch { /* the page stands without them */ }
    }
    load()
    const t = setInterval(load, 15000)
    return () => { dead = true; clearInterval(t) }
  }, [])
  return data
}

/** The home page: a centred hero, the stat strip, the steps, and the latest launches. */
function Landing() {
  const data = useLaunchData()
  // ⚠ The chain clock went with the countdown: the cards no longer show one.
  /**
   * ⛔ Our own token FIRST, by position rather than by date. It has no `firstSeen` — it never
   * opened a window — and `b.firstSeen - a.firstSeen` on a null is NaN, which leaves the sort
   * order up to the engine. It was simply absent from this strip, which is the one place the
   * front page is meant to show it.
   */
  const all = data?.sales ?? []
  const featured = all.filter((s) => s.featured)
  const rest = all.filter((s) => !s.featured).sort((a, b) => b.firstSeen - a.firstSeen)
  const latest = [...featured, ...rest].slice(0, 6)
  return (
    <>
      <section className="pf-hero">
        <div className="wrap">
          <img className="pf-hero-mark" src={logo} alt="" />
          <h1><span className="pf-pump">Pump</span> Family</h1>
          <p className="pf-lede">Every token starts on FOMO</p>
          <div className="pf-cta">
            <a className="btn primary lg" href="/create">Launch a token</a>
            <a className="btn lg" href="/how">How it works</a>
          </div>
          {/* ⭐ The platform's own token, under its own hero.
              ⛔ Before the coin exists this says the ticker and that the address is still to come.
              It does NOT show a fake address, a zero market cap or a dead link — the one thing a
              contract address must never be is wrong, and "not yet" is the honest state. The whole
              block switches on `FAMILY_CA` in family.js, the same value that lifts the launch gate,
              so the two can never disagree. */}
          <FamilyStrip />
          {/* One figure, not three. "Windows open" and "Raised" both read 0 on a quiet day and
              made the hero look like a dashboard nobody was using. */}
          {data?.stats && (
            <div className="pf-stats one">
              <div><span>Launches</span><b>{fmt(data.stats.launches ?? 0)}</b></div>
            </div>
          )}
        </div>
      </section>

      <section className="pf-section">
        <div className="wrap">
          <div className="pf-head center">
            <p className="eyebrow">How it works</p>
            <h2>First buys on FOMO</h2>
          </div>
          <div className="steps">
            {[
              ['Launch a token', 'Choose your name, logo and FOMO window. Your token is created at launch with no dev allocation.'],
              ['First buyers', 'First buys can only be done through FOMO. USDC is sent from the FOMO app and each buy takes its place on the launch curve.'],
              ['Tokens', 'Tokens are received on FOMO and become tradeable as soon as the buy window ends.'],
            ].map(([t, d], i) => (
              <div className="step" key={t}>
                <span className="step-n">{String(i + 1).padStart(2, '0')}</span>
                <h3>{t}</h3>
                <p>{d}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="pf-section alt">
        <div className="wrap">
          <div className="pf-head center">
            <p className="eyebrow">Launches</p>
            <h2>Latest launches</h2>
          </div>
          {latest.length ? (
            <>
              <div className="lc-grid">{latest.map((s) => <TokenCard key={s.address} sale={s} solUsd={data?.solUsd ?? null} />)}</div>
              {/* ⚠ A fixed label. The count read "See all 1 launches" — wrong grammar at one, and a number
                  that is not what anyone is deciding on when they press it. */}
              <div className="pf-more"><a className="btn" href="/explore">View all launches</a></div>
            </>
          ) : (
            <div className="empty">
              <h3>{data ? 'No launches yet' : 'Reading the launches…'}</h3>
              {data && <p>Be the first one to <a href="/create">launch a token</a>.</p>}
            </div>
          )}
        </div>
      </section>
    </>
  )
}

function Footer({ walletError }) {
  return (
    <footer className="pf-footer">
      {/* The mark and one link out, centred. Every page the nav listed is one tap away in the
          header, and repeating them under it was a sitemap for a four-page site. */}
      <div className="wrap pf-footer-center">
        <a className="pf-brand" href="/"><span className="pf-tile"><img src={logo} alt="" /></span><span className="pf-name"><span className="pf-pump">Pump</span> Family</span></a>
        {/* ⛔ The same pair again, shown ONLY on a phone. The header drops them there — the brand,
            the wallet button and two circles do not fit one row — and without this they would
            vanish from small screens altogether, which is how moving them out of the footer
            quietly cost every phone visitor both links. CSS decides which copy is visible. */}
        <span className="footer-social"><SocialLinks /></span>
        {/* A wallet that refuses to connect has to say so somewhere the page always has room for. */}
        {walletError && <p className="pf-footer-warn">{walletError}</p>}
      </div>
    </footer>
  )
}

export default function App() {
  const wallet = useWallet(CHAIN)
  // ⛔ The hash URL is upgraded BEFORE the first route is read, so an old `#sale?sale=…` link
  // lands on the sale rather than on the home page for a beat and then moving.
  const [route, setRoute] = useState(() => { upgradeHashUrl(); return routeOf() })
  useEffect(() => onRouteChange(() => setRoute(routeOf())), [])
  useEffect(() => interceptLinks(), [])

  // The landing is not part of the app: it has no header and no chrome, so both the shell and
  // the layout key off one derivation rather than repeating the route list.
  const inApp = ['/sale', '/token', '/create', '/explore', '/portfolio', '/mytokens', '/how'].includes(route)

  // Each route is a different page, so it starts at the top. Without this, following a coin from
  // half way down the listing opens its sale page already scrolled past the deposit box.
  useEffect(() => { window.scrollTo(0, 0) }, [route])

  /**
   * Whether the program this build targets exists on the cluster this build reads.
   *
   * ⛔ Checked once, in the shell, because it governs EVERY action on every page. A build carries
   * one program id and is pointed at a cluster separately, and when those disagree nothing works —
   * but nothing says so either, until a wallet has been asked to sign something that cannot land.
   *
   * `null` while unknown: the banner must not flash on a slow RPC, and an unreachable RPC is not
   * an absent program.
   */
  const [deployed, setDeployed] = useState(null)
  useEffect(() => {
    let alive = true
    programDeployed(connectionFor(CHAIN))
      .then((r) => { if (alive) setDeployed(r) })
      .catch(() => { if (alive) setDeployed({ ok: true, unknown: true }) })
    return () => { alive = false }
  }, [])
  const undeployed = deployed && !deployed.ok

  return (
    <>
      <header className="hdr">
        <div className="hdr-in">
          <a className="pf-brand" href="/" aria-label="Pump Family home">
            <span className="pf-tile"><img src={logo} alt="" /></span>
            <span className="pf-name"><span className="pf-pump">Pump</span> Family</span>
          </a>
          <nav className="seg">
            {/* `Your positions` and `My tokens` live in the wallet menu instead: both are about
                ONE wallet, and neither means anything until one is connected. The words in `long`
                drop on a phone so the rest fit on one row. */}
            {[['/create', 'Launch'], ['/explore', 'Explore'], ['/how', <><span className="long">How it works</span><span className="short">How</span></>]].map(([h, l]) => (
              <a key={h} href={h} className={route === h || (h === '/explore' && (route === '/sale' || route === '/token')) ? 'on' : ''}>{l}</a>
            ))}
          </nav>
          <div className="hdr-right"><SocialLinks /><WalletBar wallet={wallet} /></div>
        </div>
      </header>

      <main className={inApp ? 'wrap' : 'bleed'}>
        {/* Stated once, above whatever page you are on, because it applies to all of them. The
            wording names the cluster and the id: "something is wrong" sends a reader looking at
            their wallet, and the actual mismatch is between the build and the endpoint. */}
        {inApp && undeployed && (
          <div className="empty" style={{ marginBottom: 22 }}>
            {deployed.unreachable ? (
              <>
                <h3>The chain is not readable from here</h3>
                <p>
                  This page reads <span className="mono">{CHAIN.replace('solana:', '')}</span> at{' '}
                  <span className="mono">{deployed.endpoint}</span>, and that endpoint is not
                  answering. Nothing on this page is accurate while that is true, so the actions are
                  turned off rather than offered against numbers that could not be read.
                </p>
                <p className="mono dim">{deployed.error}</p>
              </>
            ) : (
              <>
                <h3>This build is reading a cluster the program is not on</h3>
                <p>
                  Every action here — opening a sale, launching, delivering — is sent to{' '}
                  <span className="mono">{PROGRAM_ID.toBase58()}</span>, and that address holds{' '}
                  {deployed.present ? 'an account that is not a program' : 'no account'} on{' '}
                  <span className="mono">{CHAIN.replace('solana:', '')}</span>.
                </p>
                <p>
                  Reading works, so the listing and any sale address you have are accurate. Sending
                  does not, so the actions are turned off rather than offered — a transaction to an
                  address with no program there costs a signature and a fee and cannot succeed.
                </p>
              </>
            )}
          </div>
        )}
        {route === '/explore' && <Explore undeployed={undeployed} />}
        {route === '/mytokens' && <MyTokens wallet={wallet} />}
        {route === '/portfolio' && <Portfolio chain={CHAIN} wallet={wallet} undeployed={undeployed} />}
        {route === '/sale' && <Sale chain={CHAIN} wallet={wallet} undeployed={undeployed} />}
        {/* ⛔ Its own page, not the sale page: FAMILY has no Sale account and never will. */}
        {route === '/token' && <FamilyToken mint={tokenParam()} />}
        {route === '/create' && <Create chain={CHAIN} wallet={wallet} undeployed={undeployed} />}
        {route === '/how' && <HowBody />}

        {!inApp && <Landing />}
      </main>
      <Footer walletError={wallet.error} />
    </>
  )
}
