/**
 * Token metadata: the path from a sale's `uri` to the picture a visitor sees.
 *   node indexer/metadata.test.mjs        (no chain, no network)
 *
 * ⛔⛔ This file exists because the old resolver recorded EVERY non-200 as `failed`, and `failed`
 * was never retried. Measured 21 Sep 2026: `ipfs.io` answered **429 to seven of the eight** newest
 * pump.fun metadata URIs from this machine. Under the old rule that is seven good tokens with no
 * image on this site, permanently, with nothing logged and nothing to notice.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openStore } from './store.mjs'
import { cidOf, gatewayFor, candidatesFor, fetchMetadataDocument, fetchPublic, readBounded, isPublicAddress, MAX_METADATA_BYTES, NOT_FOUND, METADATA_ATTEMPTS } from './indexer.mjs'

let pass = 0, fail = 0
const ok = (n, c, d = '') => { c ? (pass++, console.log('  ✅', n)) : (fail++, console.log('  ❌', n, d)) }

console.log('\n── a CID is found wherever it is written ──')
{
  ok('in an ipfs:// reference', cidOf('ipfs://bafkreiabc') === 'bafkreiabc')
  ok('in a gateway URL', cidOf('https://ipfs.io/ipfs/QmXyz') === 'QmXyz')
  ok('with a path after it', cidOf('ipfs://QmXyz/image.png') === 'QmXyz/image.png')
  ok('and a plain URL has none', cidOf('https://example.com/a.json') === null)
  ok('a non-string is not a CID', cidOf(undefined) === null && cidOf(42) === null)
}

console.log('\n── an image is served from a gateway that answers ──')
{
  ok('an ipfs:// image becomes fetchable', gatewayFor('ipfs://QmXyz').startsWith('https://'))
  /**
   * ⛔ The one that shipped broken. `https://ipfs.io/ipfs/<cid>` is a well-formed https URL, so
   * the old rule passed it straight through to the browser — pointing at the host that refused
   * us six times out of six. A CID is portable; the host in the document is not a promise.
   */
  ok('a gateway URL is RE-POINTED, not passed through',
     gatewayFor('https://ipfs.io/ipfs/QmXyz') === gatewayFor('ipfs://QmXyz'),
     gatewayFor('https://ipfs.io/ipfs/QmXyz'))
  ok('a plain https image is left exactly alone',
     gatewayFor('https://cdn.example.com/a.webp') === 'https://cdn.example.com/a.webp')
  ok('every candidate for a CID is a distinct host', (() => {
    const c = candidatesFor('https://ipfs.io/ipfs/QmXyz')
    return c.length > 1 && new Set(c).size === c.length
  })())
  ok('a non-IPFS URI is tried only as itself', candidatesFor('https://example.com/a.json').length === 1)
}

console.log('\n── a refusal is not a dead link ──')
{
  const log = []
  const fake = (status, body = '{"image":"ipfs://QmPic","name":"n","symbol":"s"}') => async (url) => {
    log.push(url)
    return { ok: status === 200, status, text: async () => body }
  }
  ok('a 200 on the first host returns the document and tries nothing else', await (async () => {
    log.length = 0
    const d = await fetchMetadataDocument('https://ipfs.io/ipfs/QmXyz', fake(200))
    return typeof d === 'string' && log.length === 1
  })())
  /** ⭐ The measured case: one gateway rate-limits, the CID is fine, another host has it. */
  ok('a 429 moves on to the next gateway instead of giving up', await (async () => {
    log.length = 0
    let n = 0
    const f = async (url) => { log.push(url); n++; return n === 1 ? { ok: false, status: 429 } : { ok: true, status: 200, text: async () => '{}' } }
    const d = await fetchMetadataDocument('https://ipfs.io/ipfs/QmXyz', f)
    return d === '{}' && log.length === 2
  })())
  ok('every host refusing gives null — "try again", never "dead"', await (async () => {
    const d = await fetchMetadataDocument('https://ipfs.io/ipfs/QmXyz', fake(429))
    return d === null
  })())
  ok('a throwing host is survived too', await (async () => {
    const d = await fetchMetadataDocument('https://ipfs.io/ipfs/QmXyz', async () => { throw new Error('ECONNRESET') })
    return d === null
  })())
  /** ⛔ Only a definite 404 from every candidate settles it. One gateway not holding a CID does not. */
  ok('404 everywhere is NOT_FOUND, which is settled', await (async () => {
    const d = await fetchMetadataDocument('https://ipfs.io/ipfs/QmXyz', fake(404))
    return d === NOT_FOUND
  })())
  ok('a 404 on one host and a 200 on another still returns the document', await (async () => {
    let n = 0
    const f = async () => { n++; return n === 1 ? { ok: false, status: 404 } : { ok: true, status: 200, text: async () => '{"a":1}' } }
    return await fetchMetadataDocument('https://ipfs.io/ipfs/QmXyz', f) === '{"a":1}'
  })())
}

console.log('\n── the retry queue ──')
{
  const dir = mkdtempSync(join(tmpdir(), 'pf-meta-'))
  const store = openStore(join(dir, 'x.db'))
  const now = 1_800_000_000
  const A = 'SaLeAAAA', B = 'SaLeBBBB'
  for (const a of [A, B]) {
    store.add(a, now)
    store.put(a, {
      mint: { toBase58: () => '11111111111111111111111111111111' }, name: 'n', symbol: 's',
      uri: 'https://ipfs.io/ipfs/QmXyz',
      authority: { toBase58: () => '11111111111111111111111111111111' },
      creatorFeeRecipient: { toBase58: () => '11111111111111111111111111111111' },
      status: 0, windowEnd: 0n, launchDeadline: 0n, hardCap: 0n, minRaise: 0n, perWalletCap: 0n,
      quote: 1, quoteMint: { toBase58: () => '11111111111111111111111111111111' },
      gross: 0n, sold: 0n, depositors: 0,
    }, now)
  }
  ok('both start unresolved', store.pendingMetadata(10, now).length === 2)

  // A parks for a retry; B is settled as dead.
  store.putMetadata(A, {}, 'retry', now + 60)
  store.putMetadata(B, {}, 'failed', null)
  ok('a parked row is NOT due yet', store.pendingMetadata(10, now).length === 0)
  ok('and IS due once its backoff expires', store.pendingMetadata(10, now + 61).some((r) => r.address === A))
  /** ⛔ The whole bug, as one assertion: a settled failure never comes back. */
  ok('a settled failure never returns, however long you wait',
     !store.pendingMetadata(10, now + 86_400 * 365).some((r) => r.address === B))
  ok('a resolved row never returns either', (() => {
    store.putMetadata(A, { image: 'https://x/a.png' }, 'ok', null)
    return !store.pendingMetadata(10, now + 86_400 * 365).some((r) => r.address === A)
  })())
  ok('attempts are counted, so a retry can eventually give up', (() => {
    const row = store.get(A)
    return row.meta_tries >= 2
  })(), String(store.get(A)?.meta_tries))
  ok(`and the budget is finite (${METADATA_ATTEMPTS} attempts)`, METADATA_ATTEMPTS > 1 && METADATA_ATTEMPTS < 50)
  store.close(); rmSync(dir, { recursive: true, force: true })
}

console.log('\n── where the creator fee goes, carried to the page ──')
{
  /**
   * ⛔ Three states, not two. A sale written before this column existed has NO answer, and the
   * page must stay silent rather than print the default — "to the creator" on a sale nobody read
   * is a claim, and this one is permanent and unrepairable.
   */
  const dir = mkdtempSync(join(tmpdir(), 'pf-hr-'))
  const store = openStore(join(dir, 'x.db'))
  const now = 1_800_000_000
  const sale = (addr, holderRewards) => {
    store.add(addr, now)
    store.put(addr, {
      mint: { toBase58: () => '11111111111111111111111111111111' }, name: 'n', symbol: 's', uri: '',
      authority: { toBase58: () => '11111111111111111111111111111111' },
      creatorFeeRecipient: { toBase58: () => '11111111111111111111111111111111' },
      status: 1, windowEnd: 0n, launchDeadline: 0n, hardCap: 0n, minRaise: 0n, perWalletCap: 0n,
      quote: 1, quoteMint: null, gross: 0n, sold: 0n, depositors: 0, holderRewards,
    }, now)
  }
  sale('ToHolders', true)
  sale('ToCreator', false)
  ok('a holder-rewards sale stores 1', store.get('ToHolders').holder_rewards === 1,
     String(store.get('ToHolders').holder_rewards))
  /** ⛔ Zero, never null. `undefined` binds as null and would read back as "unknown". */
  ok('a creator-rewards sale stores 0, not null', store.get('ToCreator').holder_rewards === 0,
     String(store.get('ToCreator').holder_rewards))
  ok('and false is distinguishable from never-written',
     store.get('ToCreator').holder_rewards !== null)
  store.close(); rmSync(dir, { recursive: true, force: true })
}

console.log('\n── the attester alert ──')
{
  /**
   * ⛔ The alert exists because running dry is the QUIET failure: buyers who paid are simply not
   * delivered to, nothing reverts, nothing errors, and the site reports itself healthy.
   */
  const { attesterStatus, alert, LOW_LAMPORTS, LAMPORTS_PER_BUYER } = await import('../watcher/alert.mjs')
  const addr = 'FQSSoz8zmFVkg3Yi3qraxFPLBs5Bwug1jrv2gsGGkG7q'

  ok('a healthy balance is not low', attesterStatus(300_000_000, addr).low === false)
  ok('and it says how many buyers that is', attesterStatus(300_000_000, addr).buyers === Math.floor(300_000_000 / LAMPORTS_PER_BUYER))
  ok('a balance under the floor IS low', attesterStatus(LOW_LAMPORTS - 1, addr).low === true)
  /** ⛔ The one that matters: an RPC that refused the call is not evidence about the wallet. */
  ok('a balance that could not be READ is null, not low', attesterStatus(null, addr) === null)
  ok('undefined likewise', attesterStatus(undefined, addr) === null)

  // The webhook: optional, non-fatal, rate limited.
  const prev = process.env.ALERT_WEBHOOK
  delete process.env.ALERT_WEBHOOK
  ok('with no webhook it is a silent no-op', (await alert('k', 'x')).sent === false)

  process.env.ALERT_WEBHOOK = 'https://example.invalid/hook'
  let calls = 0
  const okFetch = async () => { calls++; return { ok: true, status: 200 } }
  const first = await alert('low', 'text', { now: 1_000_000, fetchImpl: okFetch })
  const again = await alert('low', 'text', { now: 1_000_001, fetchImpl: okFetch })
  ok('the first alert is sent', first.sent === true, first.why)
  /** ⛔ The watcher loops every 15s. Unthrottled this is 5,760 messages a day and gets muted. */
  ok('an immediate repeat is rate limited, not sent', again.sent === false && again.why === 'rate limited')
  ok('and only one request was actually made', calls === 1, String(calls))
  const later = await alert('low', 'text', { now: 1_000_000 + 3_600_001, fetchImpl: okFetch })
  ok('but it does come back after the interval', later.sent === true)

  /** ⛔ A failing webhook must never take the watcher down: the alert is the least important thing. */
  ok('a webhook that throws is survived', (await alert('boom', 't', { now: 2e9, fetchImpl: async () => { throw new Error('ECONNRESET') } })).sent === false)
  ok('a webhook that 500s is survived', (await alert('five', 't', { now: 3e9, fetchImpl: async () => ({ ok: false, status: 500 }) })).sent === false)
  if (prev === undefined) delete process.env.ALERT_WEBHOOK; else process.env.ALERT_WEBHOOK = prev
}

console.log('\n── a launched token stays listed ──')
{
  /**
   * The question this answers: once a FOMO window closes, is the token still on the site?
   *
   * ⛔ Yes, and nothing may quietly un-list it. A sale is marked missing whenever ONE read comes
   * back empty, and an RPC returning null for an account that exists happens under load. At the
   * old `missing = 0` threshold a single blip made a launched token vanish from the front page
   * and from Explore, with nothing logged and /api/health still green.
   */
  const dir = mkdtempSync(join(tmpdir(), 'pf-listed-'))
  const store = openStore(join(dir, 'x.db'))
  const now = 1_800_000_000
  const addr = 'LaunchedSale1111'
  const put = (status) => store.put(addr, {
    mint: { toBase58: () => 'MintAAAA11111111111111111111111111111111111' },
    name: 'Closed Window', symbol: 'CLOSED', uri: '',
    authority: { toBase58: () => '11111111111111111111111111111111' },
    creatorFeeRecipient: { toBase58: () => '11111111111111111111111111111111' },
    status, windowEnd: BigInt(now - 3600), launchDeadline: BigInt(now - 60),
    hardCap: 0n, minRaise: 0n, perWalletCap: 0n, quote: 1,
    quoteMint: { toBase58: () => 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' },
    gross: 100_000_000n, sold: 1_000_000_000n, depositors: 4, holderRewards: false,
  }, now)
  store.add(addr, now)
  put(1)   // launched, window long closed

  const listedNow = () => store.all().some((r) => r.address === addr)
  ok('a LAUNCHED sale with a closed window is listed', listedNow())
  ok('and it is offered for pricing, so its market cap keeps updating',
     store.launched().some((r) => r.address === addr))

  store.miss(addr, now)
  ok('⭐ one missed read does NOT un-list it', listedNow())
  store.miss(addr, now)
  ok('nor does a second', listedNow())
  store.miss(addr, now)
  ok('a third does — by then it is not a blip', !listedNow())
  put(1)
  ok('and one good read brings it straight back', listedNow())

  store.close(); rmSync(dir, { recursive: true, force: true })
}

console.log('\n── the metadata URI is the creator\'s, and it is fetched from inside the box ──')
{
  /**
   * 🔴 SSRF (outside review, 22 Sep 2026): a creator could point the URI at 127.0.0.1, the box's
   * private services or a cloud metadata endpoint — directly, or by redirecting there from a
   * public host — and the old fetch followed redirects blindly and downloaded the whole body
   * before cutting it.
   */
  for (const [ip, want] of [
    ['127.0.0.1', false], ['10.0.0.1', false], ['172.16.5.5', false], ['192.168.1.1', false],
    ['169.254.169.254', false], ['100.64.0.1', false], ['0.0.0.0', false], ['::1', false], ['fe80::1', false],
    ['fd12::1', false], ['::ffff:127.0.0.1', false], ['::ffff:10.0.0.1', false],
    ['8.8.8.8', true], ['172.32.0.1', true], ['2606:4700::1111', true], ['::ffff:1.1.1.1', true],
  ]) ok(`${ip} is ${want ? 'public' : 'refused'}`, isPublicAddress(ip) === want)

  const hosts = { 'public.example': ['93.184.216.34'], 'inside.example': ['10.0.0.5'], 'mixed.example': ['93.184.216.34', '127.0.0.1'], 'nowhere.example': [] }
  const lookup = async (h) => hosts[h] ?? []
  const calls = []
  const fetchImpl = async (url, opts) => {
    calls.push({ url, redirect: opts.redirect })
    const u = new URL(url)
    if (u.pathname === '/hop') return { ok: false, status: 302, headers: new Map([['location', 'http://inside.example/secret']]) }
    if (u.pathname === '/hop-public') return { ok: false, status: 301, headers: new Map([['location', 'https://public.example/final.json']]) }
    if (u.pathname === '/loop') return { ok: false, status: 302, headers: new Map([['location', url]]) }
    return { ok: true, status: 200, headers: new Map(), text: async () => '{"a":1}' }
  }
  const refused = async (url) => { try { await fetchPublic(url, fetchImpl, lookup); return false } catch { return true } }
  calls.length = 0
  ok('a private host is refused before any request is made', await refused('http://inside.example/x') && calls.length === 0)
  ok('a literal loopback address is refused', await refused('http://127.0.0.1:5250/logos'))
  ok('a literal link-local (cloud metadata) address is refused', await refused('http://169.254.169.254/latest/meta-data/'))
  ok('a host that resolves to a public AND a private address is refused', await refused('http://mixed.example/x'))
  ok('a host that does not resolve is refused', await refused('http://nowhere.example/x'))
  ok('a non-http scheme is refused', await refused('file:///etc/passwd') && await refused('ftp://public.example/x'))
  calls.length = 0
  ok('a public host that redirects to a private one is refused at the hop', await refused('https://public.example/hop') && calls.length === 1)
  calls.length = 0
  const res = await fetchPublic('https://public.example/hop-public', fetchImpl, lookup)
  ok('a redirect to another public host is followed, by hand', res.ok && calls.length === 2 && calls.every((c) => c.redirect === 'manual'))
  ok('a redirect loop gives up', await refused('https://public.example/loop'))
  ok('the document fetch itself refuses a private URI', await fetchMetadataDocument('http://inside.example/meta.json', fetchImpl, { lookup }) === null)
  ok('and still reads a public one', await fetchMetadataDocument('https://public.example/meta.json', fetchImpl, { lookup }) === '{"a":1}')

  // The body is cut mid-stream, not after download.
  let pulled = 0
  const chunk = new Uint8Array(16_000).fill(97)
  const stream = new ReadableStream({ pull(c) { pulled++; if (pulled > 1000) c.close(); else c.enqueue(chunk) } })
  const body = await readBounded({ body: stream }, MAX_METADATA_BYTES)
  ok(`a body that never ends is cut at ${MAX_METADATA_BYTES} bytes`, body.length === MAX_METADATA_BYTES)
  ok('after pulling only what it needed, not the whole thing', pulled <= Math.ceil(MAX_METADATA_BYTES / 16_000) + 1, `pulled ${pulled} chunks`)
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
