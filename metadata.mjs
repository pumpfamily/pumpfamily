/**
 * Token metadata: upload, and above all validation.
 *
 * ⛔⛔ pump.fun writes the Metaplex metadata account with **`is_mutable = false`**, and the update
 * authority is pump.fun's own `mint-authority` PDA. Verified by launching on a validator running
 * mainnet's cloned program. So a token's name, symbol and URI are **permanent from the moment it
 * launches** and nobody can repair them afterwards, not the creator and not us.
 *
 * A Pump Family sale makes this worse by fixing the URI when the sale OPENS, potentially days
 * before the mint exists. A URI that 404s, or an image link that rots in the meantime, produces a
 * permanently broken token that people have already paid for. Hence: validate hard, up front, and
 * prefer content-addressed storage over anything mutable.
 */

/**
 * In the browser the upload goes through our own server (`/api/ipfs` in indexer/server.mjs):
 * pump.fun's route sends no CORS header, so a page can post to it but never read the answer.
 * Node calls pump.fun directly.
 */
const inBrowser = typeof window !== 'undefined'
const IPFS_UPLOAD = inBrowser
  // Written without `?.` on purpose: Vite only replaces the literal `import.meta.env.X`, and a
  // production build must drop the localhost branch (deploy.sh refuses a bundle that keeps it).
  ? `${import.meta.env.VITE_INDEXER_URL ?? (import.meta.env.DEV ? 'http://localhost:5241' : '')}/api/ipfs`
  : 'https://pump.fun/api/ipfs'
export const MAX_NAME = 32
export const MAX_SYMBOL = 10
export const MAX_URI = 200

/** Storage that cannot silently change under a token that has already launched. */
const isImmutableHost = (u) => /^(ipfs:\/\/|https?:\/\/[^/]*ipfs)/i.test(u) || /\/ipfs\//i.test(u)

/**
 * ⛔⛔ ONE GATEWAY'S ANSWER IS NOT EVIDENCE ABOUT A CID.
 *
 * pump.fun's upload returns the document on `ipfs.io`, and ipfs.io rate-limits: it answered **429**
 * for a CID that `gateway.pinata.cloud` and `ipfs.filebase.io` both served as `application/json`
 * in the same second. In a browser a 429 with no CORS headers arrives as the generic "Failed to
 * fetch", so the launch form told the creator their metadata was unfit and refused to launch — on
 * a document that was pinned, valid, and retrievable.
 *
 * ⚠ The URI is still validated AS GIVEN first, because that string is what gets frozen on chain
 * and it must be the thing that was checked. The other gateways only answer the question the
 * first one could not: does this CID resolve at all. Same list and same order as the indexer's.
 */
const GATEWAYS = [
  'https://pump.mypinata.cloud/ipfs/',
  'https://gateway.pinata.cloud/ipfs/',
  'https://ipfs.filebase.io/ipfs/',
  'https://ipfs.io/ipfs/',
]

/** The CID (and any path after it) inside an `ipfs://` or `.../ipfs/<cid>` URL, else null. */
const cidOf = (u) => {
  if (typeof u !== 'string') return null
  const direct = /^ipfs:\/\/(?:ipfs\/)?(.+)$/i.exec(u.trim())
  if (direct) return direct[1]
  const viaPath = /\/ipfs\/([^?#]+)/i.exec(u)
  return viaPath ? viaPath[1] : null
}

/** The given URI first, then the same CID on every other gateway. */
const candidatesFor = (uri) => {
  const out = [uri]
  const cid = cidOf(uri)
  if (!cid) return out
  let host = ''
  try { host = new URL(uri).origin + '/ipfs/' } catch { /* not a URL; the CID still is */ }
  for (const g of GATEWAYS) if (g !== host) out.push(g + cid)
  return out
}

/**
 * Fetches a candidate metadata URI and reports every reason it is unfit to be permanent.
 *
 * Returns `{ ok, errors, warnings, metadata }`. Errors are disqualifying; warnings are survivable
 * but worth showing to whoever is about to freeze this forever.
 */
const hostOf = (u) => { try { return new URL(u).host } catch { return u } }

export async function validateMetadataUri(uri, fetchImpl = fetch) {
  const errors = [], warnings = []
  if (!uri) return { ok: false, errors: ['No URI supplied.'], warnings, metadata: null }
  if (uri.length > MAX_URI) errors.push(`URI is ${uri.length} characters; pump.fun stores at most ${MAX_URI}.`)
  if (!/^https?:\/\//i.test(uri)) errors.push('URI must be an http or https URL that wallets can fetch.')
  if (!isImmutableHost(uri)) {
    warnings.push('This URI is not content addressed. If it ever moves or expires the token is permanently broken, because the metadata cannot be repointed.')
  }

  let metadata = null
  {
    // ⛔ Walked, not fetched once. See GATEWAYS above: a 429 from the one host pump.fun happens to
    // name is a fact about that host's load, never about whether the document exists.
    const tried = []
    for (const url of candidatesFor(uri)) {
      try {
        const res = await fetchImpl(url, { redirect: 'follow' })
        if (!res.ok) { tried.push(`${hostOf(url)} HTTP ${res.status}`); continue }
        const text = await res.text()
        try { metadata = JSON.parse(text); break }
        // ⚠ Valid response, invalid body: that is the DOCUMENT being wrong, so stop rather than
        // let another gateway serve the same bad bytes and report a different reason.
        catch { errors.push('URI did not return valid JSON.'); break }
      } catch (e) {
        tried.push(`${hostOf(url)} ${e.message}`)
      }
    }
    if (!metadata && !errors.some((e) => e.includes('valid JSON'))) {
      errors.push(`Could not fetch the metadata from any gateway (${tried.join('; ')}).`)
    }
  }

  if (metadata) {
    // Shape taken from a real pump.fun launch, not from documentation.
    for (const field of ['name', 'symbol', 'image']) {
      if (!metadata[field]) errors.push(`Metadata is missing "${field}".`)
    }
    if (metadata.name && metadata.name.length > MAX_NAME) errors.push(`name is longer than ${MAX_NAME} characters.`)
    if (metadata.symbol && metadata.symbol.length > MAX_SYMBOL) errors.push(`symbol is longer than ${MAX_SYMBOL} characters.`)
    if (metadata.image && !isImmutableHost(metadata.image)) {
      warnings.push('The image is not content addressed, so it can rot independently of the metadata.')
    }
    if (metadata.image) {
      // ⛔ Walked too. The image sits on the same rate-limited host as the document, and a 429
      // here failed a launch whose picture was pinned and served fine one gateway over. This is
      // the SAME defect as the document fetch above; fixing one and not the other just moves the
      // false refusal down a line.
      const tried = []
      let reached = false
      for (const url of candidatesFor(metadata.image)) {
        try {
          const img = await fetchImpl(url, { method: 'GET', redirect: 'follow' })
          if (img.ok) { reached = true; break }
          tried.push(`${hostOf(url)} HTTP ${img.status}`)
        } catch (e) { tried.push(`${hostOf(url)} ${e.message}`) }
      }
      if (!reached) errors.push(`Could not fetch the image from any gateway (${tried.join('; ')}).`)
    }
  }
  return { ok: errors.length === 0, errors, warnings, metadata }
}

/**
 * Uploads an image and metadata to pump.fun's IPFS route and returns `{ metadata, metadataUri }`.
 *
 * ⚠ The route is a multipart POST and **rejects an empty file** — there is no metadata-only path.
 * ⚠ This publishes to public IPFS and cannot be undone. Validate before calling, not after.
 */
export async function uploadMetadata({ file, name, symbol, description = '', twitter, telegram, website }, fetchImpl = fetch) {
  if (!file) throw new Error('pump.fun\'s IPFS route rejects an upload with no image')
  const form = new FormData()
  form.append('file', file)
  form.append('name', name)
  form.append('symbol', symbol)
  form.append('description', description)
  if (twitter) form.append('twitter', twitter)
  if (telegram) form.append('telegram', telegram)
  if (website) form.append('website', website)
  form.append('showName', 'true')
  const res = await fetchImpl(IPFS_UPLOAD, { method: 'POST', body: form })
  if (!res.ok) throw new Error(`pump.fun IPFS upload failed: HTTP ${res.status}`)
  return res.json()
}

/*
 * `process` does not exist in a browser, and these modules are imported by the web app. An
 * unguarded `process.argv` here throws at module evaluation, which Vite reports as a failed hot
 * update while leaving the PREVIOUS build running: the page looks fine and is silently stale.
 */
const isCli = typeof process !== 'undefined' && Array.isArray(process.argv)
  && import.meta.url === `file://${process.argv[1]}`

if (isCli) {
  const uri = process.argv[2]
  if (!uri) { console.log('usage: node metadata.mjs <metadata-uri>'); process.exit(1) }
  const r = await validateMetadataUri(uri)
  console.log(r.ok ? '✅ fit to freeze forever' : '❌ NOT fit to launch with')
  r.errors.forEach((e) => console.log('   error  :', e))
  r.warnings.forEach((w) => console.log('   warning:', w))
  if (r.metadata) console.log('   name/symbol:', r.metadata.name, '/', r.metadata.symbol)
}
