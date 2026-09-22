/**
 * Path routing, without a router library.
 *
 * The app used to route on the hash, which is why every URL carried a `#`. Real paths cost three
 * things and nothing else: this module, a click handler that keeps internal links from reloading
 * the page, and a server that answers an unknown path with `index.html` — see the `try_files` line
 * in `server/pump.family.caddy`. ⛔ Ship those together: a path build served without the fallback
 * 404s on every link a visitor opens directly or refreshes.
 *
 * Routes are `/`, `/explore`, `/create`, `/portfolio`, `/mytokens`, `/how`, `/sale/<address>`
 * and `/token/<mint>` — the platform's own coin, which has no sale behind it.
 */

/** The current path, with any trailing slash removed. `/` stays `/`. */
export const pathOf = () => location.pathname.replace(/\/+$/, '') || '/'

/** The first segment, which is what decides the page: `/sale/abc` → `/sale`. */
export const routeOf = () => {
  const p = pathOf()
  const i = p.indexOf('/', 1)
  return i === -1 ? p : p.slice(0, i)
}

/** `/sale/<address>` → the address, or '' anywhere else. */
export const saleParam = () => {
  const m = /^\/sale\/([1-9A-HJ-NP-Za-km-z]{32,44})$/.exec(pathOf())
  return m ? m[1] : ''
}

/** `/token/<mint>` → the mint, or '' anywhere else. Same shape rule as a sale address. */
export const tokenParam = () => {
  const m = /^\/token\/([1-9A-HJ-NP-Za-km-z]{32,44})$/.exec(pathOf())
  return m ? m[1] : ''
}

export const queryOf = (name) => new URLSearchParams(location.search).get(name)

/**
 * A navigation the app handles itself.
 *
 * `popstate` does not fire on `pushState`, so it is dispatched here: one event every listener can
 * subscribe to, whether the change came from a link, the back button or code.
 */
export function navigate(href, { replace = false } = {}) {
  const url = new URL(href, location.origin)
  if (url.pathname === pathOf() && url.search === location.search) return
  history[replace ? 'replaceState' : 'pushState'](null, '', url.pathname + url.search)
  window.dispatchEvent(new PopStateEvent('popstate'))
}

/** Subscribes to every path change, however it happened. Returns the unsubscribe. */
export function onRouteChange(fn) {
  window.addEventListener('popstate', fn)
  return () => window.removeEventListener('popstate', fn)
}

/**
 * Turns same-origin `<a href="/…">` clicks into `navigate`, so the app never reloads itself.
 *
 * ⚠ Deliberately does NOT swallow: a modified click (new tab, download, a target), an external
 * link, or anything under a path the server owns. Those have to reach the browser, or a
 * middle-click stops opening a tab and `/api/…` stops being fetchable by a link.
 */
export function interceptLinks() {
  const onClick = (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
    const a = e.target.closest?.('a')
    if (!a || a.target === '_blank' || a.hasAttribute('download') || a.hasAttribute('data-native')) return
    const href = a.getAttribute('href')
    if (!href || !href.startsWith('/') || href.startsWith('//')) return
    if (/^\/(api|logos|assets)\//.test(href)) return
    e.preventDefault()
    navigate(href)
  }
  document.addEventListener('click', onClick)
  return () => document.removeEventListener('click', onClick)
}

/**
 * Rewrites a link from the hash era to its path, once, at boot.
 *
 * ⛔ Every `#sale?sale=…` link ever shared — in a chat, a tweet, someone's bookmarks — points at a
 * URL this build no longer understands. The fragment never reaches the server, so only the app can
 * answer them, and it costs four lines to keep them all working.
 */
export function upgradeHashUrl() {
  const hash = location.hash
  if (!hash.startsWith('#')) return
  const [name, query] = hash.slice(1).split('?')
  const params = new URLSearchParams(query ?? '')
  const sale = params.get('sale')
  const path = name === 'sale' && sale ? `/sale/${sale}`
    : name === 'home' || name === '' ? '/'
    : `/${name}`
  params.delete('sale')
  const rest = params.toString()
  history.replaceState(null, '', path + (rest ? `?${rest}` : ''))
}
