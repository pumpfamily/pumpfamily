/**
 * Wallet connection over the Wallet Standard.
 *
 * Deliberately enumerates every wallet the browser has registered and makes the person pick.
 * Reaching for a single injected global picks a wallet FOR the user, which is wrong whenever more
 * than one is installed: the click goes to whichever extension won the race to inject.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getWallets } from '@wallet-standard/app'

const CONNECT = 'standard:connect'
const DISCONNECT = 'standard:disconnect'
const EVENTS = 'standard:events'
const SIGN_AND_SEND = 'solana:signAndSendTransaction'

const isSolana = (w) => CONNECT in w.features && SIGN_AND_SEND in w.features

/**
 * The wallet the visitor last chose, by name.
 *
 * ⚠ A name, never an address or a key: the authorisation itself lives in the extension, and all
 * this remembers is WHICH extension to ask. Nothing here can connect anything on its own.
 *
 * ⛔ Both accessors swallow. Storage throws outright in a private window and with site data
 * blocked, and a wallet that cannot be remembered must still be connectable.
 */
const REMEMBERED = 'pumpfamily.wallet'
const remember = (name) => { try { localStorage.setItem(REMEMBERED, name) } catch { /* no storage */ } }
const forget = () => { try { localStorage.removeItem(REMEMBERED) } catch { /* no storage */ } }
const remembered = () => { try { return localStorage.getItem(REMEMBERED) } catch { return null } }

export function useWallet(chain) {
  const [available, setAvailable] = useState([])
  const [wallet, setWallet] = useState(null)
  const [account, setAccount] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    const { get, on } = getWallets()
    const refresh = () => setAvailable(get().filter(isSolana))
    refresh()
    // Extensions register asynchronously, so a one-shot read at mount misses late arrivals.
    const offRegister = on('register', refresh)
    const offUnregister = on('unregister', refresh)
    return () => { offRegister(); offUnregister() }
  }, [])

  /**
   * ⛔⛔ `connect()` CAN HANG FOR EVER, and it is the normal case, not the broken one.
   *
   * A wallet answers by opening its own approval window and resolving when the person acts there.
   * If that window opens behind the browser, or the extension is locked, or it is simply missed,
   * the promise stays pending: no resolve, no reject, nothing to catch. Measured on the live site
   * — the call was still pending 45 seconds later with no error of any kind.
   *
   * The old version awaited it with no pending state at all, so the only thing a visitor saw was
   * the menu closing. They clicked "Connect wallet", the list shut, the button still said "Connect
   * wallet", and the page looked broken while the wallet was patiently waiting to be approved.
   *
   * So the pending wallet is STATE. What is waiting is on screen, it says where to look, and it
   * can be dismissed — see the header menu.
   */
  const [connecting, setConnecting] = useState(null)
  const connect = useCallback(async (w) => {
    setError(null)
    setConnecting(w)
    try {
      const res = await w.features[CONNECT].connect()
      const acc = res.accounts[0] ?? w.accounts[0]
      if (!acc) throw new Error('wallet connected but exposed no account')
      setWallet(w); setAccount(acc); remember(w.name)
    } catch (e) {
      // ⚠ Wallets phrase a refusal differently; say which wallet it was, since the person may have
      // several and the window they dismissed is not labelled once it is gone.
      setError(`${w.name}: ${e.message ?? String(e)}`)
    } finally { setConnecting(null) }
  }, [])

  /**
   * Picks the remembered wallet back up after a reload, WITHOUT prompting.
   *
   * ⛔⛔ The whole point is that nothing pops up. A visitor who lands on a sale page and is asked
   * to approve a wallet they did not click is being interrupted by a page they only read, so this
   * takes two routes and neither of them can raise a window:
   *
   *  1. `wallet.accounts[0]` — a wallet that already trusts this origin exposes the account with
   *     no call at all. This is the common path.
   *  2. `connect({ silent: true })` — the Wallet Standard's "reconnect if you already may". A
   *     wallet that has not authorised us answers with no accounts rather than prompting.
   *
   * ⚠ `silent` is the standard's flag and the majority path (it is what wallet-adapter's own
   * autoConnect sends), but it is an INPUT, not a guarantee: a wallet free to ignore it would
   * prompt here. Route 1 covers the wallets that expose the account outright, and this only runs
   * for a wallet the visitor themselves chose on a previous visit — never for a first-time one.
   *
   * ⚠ Attempted at most once per wallet name per page. A wallet that stays locked would otherwise
   * be re-asked on every `register` event for as long as the tab is open.
   *
   * ⛔ It never touches `connecting` and never sets `error`: a silent restore that does not happen
   * is the ordinary case (the visitor simply is not connected), not a failure to report.
   */
  const tried = useRef(new Set())
  useEffect(() => {
    if (wallet || connecting) return
    const name = remembered()
    if (!name || tried.current.has(name)) return
    const w = available.find((a) => a.name === name)
    if (!w) return
    tried.current.add(name)
    let live = true
    ;(async () => {
      try {
        let acc = w.accounts[0]
        if (!acc) acc = (await w.features[CONNECT].connect({ silent: true }))?.accounts?.[0]
        if (live && acc) { setWallet(w); setAccount(acc) }
      } catch { /* not authorised, or the wallet has no silent mode: stay disconnected */ }
    })()
    return () => { live = false }
  }, [available, wallet, connecting])

  /** Stops WAITING. The wallet's own window is its to close, and a late approval still lands. */
  const cancelConnect = useCallback(() => setConnecting(null), [])

  /**
   * ⛔ Nothing else ever clears a pending connect, because a promise that never settles never
   * reaches the `finally`. Without this the header would read "Connecting to Phantom…" until the
   * page was reloaded — a stuck label is worse than the silence it replaced.
   *
   * A minute is long enough to find the wallet's window and approve it, and a late approval is
   * still honoured: this only stops the WAITING being shown.
   */
  useEffect(() => {
    if (!connecting) return
    const t = setTimeout(() => setConnecting(null), 60_000)
    return () => clearTimeout(t)
  }, [connecting])

  /**
   * Follows the wallet's own side of the connection.
   *
   * A person can switch account or revoke this site from inside the extension, and the page hears
   * about it only here. An empty `accounts` is a disconnect the wallet performed: forget the
   * choice too, or the next load would silently reconnect to something they just revoked.
   */
  useEffect(() => {
    if (!wallet) return
    const events = wallet.features[EVENTS]
    if (!events) return
    return events.on('change', (props) => {
      if (!('accounts' in props)) return
      const acc = props.accounts[0]
      if (acc) setAccount(acc)
      else { setWallet(null); setAccount(null); forget() }
    })
  }, [wallet])

  const disconnect = useCallback(async () => {
    // ⛔ Forget FIRST. If the wallet's own `disconnect` throws, the choice must still be dropped,
    // or the next page load restores a connection the person just ended.
    forget()
    tried.current.clear()
    try { await wallet?.features[DISCONNECT]?.disconnect() } catch { /* wallet may not offer it */ }
    setWallet(null); setAccount(null)
  }, [wallet])

  /**
   * Signs and sends a transaction, legacy or versioned. Returns the signature.
   *
   * ⚠ The two serialise differently: a legacy `Transaction` needs the options that let it go out
   * unsigned, and a `VersionedTransaction.serialize()` takes none and throws if handed them. A
   * quote launch is v0 by necessity — it does not fit in a legacy transaction — so this path
   * carries both rather than the caller having to know which it holds.
   */
  const signAndSend = useCallback(async (tx) => {
    if (!wallet || !account) throw new Error('no wallet connected')
    const serialized = tx.version === undefined
      ? tx.serialize({ requireAllSignatures: false, verifySignatures: false })
      : tx.serialize()
    const [out] = await wallet.features[SIGN_AND_SEND].signAndSendTransaction({
      account, chain, transaction: new Uint8Array(serialized),
    })
    // Different wallets return the signature under different shapes.
    const sig = out?.signature
    return typeof sig === 'string' ? sig : bs58(sig)
  }, [wallet, account, chain])

  const publicKey = useMemo(() => account?.address ?? null, [account])
  return { available, wallet, account, publicKey, error, connecting, connect, cancelConnect, disconnect, signAndSend }
}

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
function bs58(bytes) {
  if (!bytes) return ''
  let n = 0n
  for (const b of bytes) n = n * 256n + BigInt(b)
  let out = ''
  while (n > 0n) { out = ALPHABET[Number(n % 58n)] + out; n /= 58n }
  for (const b of bytes) { if (b === 0) out = '1' + out; else break }
  return out
}
