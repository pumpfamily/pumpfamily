/**
 * Grinds the mint seed until the sale's mint PDA ends in `fomo`.
 *
 * A SEED, not a keypair. The mint is a PDA so that `launch` needs no secret and anyone can trigger
 * it; grinding a keypair instead would put a signature back in the path and let a creator sit on
 * depositors' money. Searching a nonce keeps the address deterministic, permissionless, and
 * verifiable on chain, at the cost of some CPU here.
 *
 *   node vanity.mjs <saleAddress> [suffix]
 */
import { PublicKey } from '@solana/web3.js'
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads'
import { cpus } from 'node:os'
import { createHash, hash as oneShotHash } from 'node:crypto'
import { PROGRAM_ID } from './program.mjs'

export const VANITY_SUFFIX = 'fomo'
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

/**
 * The last `n` base58 characters of a 32 byte key, without encoding the whole thing.
 * Mirrors `has_base58_suffix` in the program, and is the reason the on-chain check is cheap.
 */
export function base58Tail(bytes, n) {
  const num = Uint8Array.from(bytes)
  let out = ''
  for (let i = 0; i < n; i++) {
    let rem = 0
    for (let j = 0; j < num.length; j++) {
      const cur = rem * 256 + num[j]
      num[j] = (cur / 58) | 0
      rem = cur % 58
    }
    out = B58[rem] + out
  }
  return out
}

/** Nonces are u64: a random high half picked per grind, so nobody can predict the mint in advance. */
const nonceBytes = (hi, lo) => { const n = Buffer.alloc(8); n.writeUInt32LE(lo >>> 0, 0); n.writeUInt32LE(hi >>> 0, 4); return n }
export const mintForNonce = (sale, nonce) => {
  const n = Buffer.alloc(8); n.writeBigUInt64LE(BigInt(nonce))
  return PublicKey.findProgramAddressSync([Buffer.from('mint'), sale.toBuffer(), n], PROGRAM_ID)[0]
}

const PDA_MARKER = Buffer.from('ProgramDerivedAddress')
const randomHi = () => (Math.random() * 0x100000000) >>> 0

/**
 * Searches [from, from+count) for a nonce whose mint PDA ends in `suffix`.
 *
 * Ordering is the whole trick. `findProgramAddressSync` costs an ed25519 curve check per attempt,
 * which at eleven million attempts is the entire runtime. So the candidate hash is computed
 * directly with bump 255 and the SUFFIX is tested first, which is four divmods and rejects
 * 57/58 of candidates immediately. Only a hash that already ends in the suffix pays for the real
 * derivation, and that confirms both the canonical bump and the address.
 *
 * Missing the occasional match (when bump 255 happens to land on the curve) is harmless: any one
 * nonce will do, and the search simply continues.
 */
export function searchRange(saleKey, suffix, from, count, hi = 0) {
  const sale = new PublicKey(saleKey)
  const seedMint = Buffer.from('mint')
  const saleBytes = sale.toBuffer()
  const programBytes = PROGRAM_ID.toBuffer()
  /*
   * One preallocated input buffer, one one-shot hash, and a suffix test that gives up after the
   * FIRST character. Each base58 character costs a full 32 byte divmod pass, and the last
   * character alone already rejects 57 candidates in 58 — so testing all four up front does
   * roughly four times the work needed to say no.
   */
  const input = Buffer.concat([seedMint, saleBytes, nonceBytes(hi, 0), Buffer.from([255]), programBytes, PDA_MARKER])
  const nonceAt = seedMint.length + saleBytes.length
  const want = Array.from(suffix).reverse().map((c) => B58.indexOf(c))
  const scratch = new Uint8Array(32)

  for (let i = from; i < from + count; i++) {
    input.writeUInt32LE(i >>> 0, nonceAt)
    const candidate = oneShotHash('sha256', input, 'buffer')

    scratch.set(candidate)
    let matched = true
    for (let d = 0; d < want.length; d++) {
      let rem = 0
      for (let j = 0; j < 32; j++) {
        const cur = rem * 256 + scratch[j]
        scratch[j] = (cur / 58) | 0
        rem = cur % 58
      }
      if (rem !== want[d]) { matched = false; break }
    }
    if (!matched) continue

    // Confirm for real: this rejects the case where bump 255 is on the curve.
    const n = nonceBytes(hi, i)
    const nonce = n.readBigUInt64LE(0).toString()
    const [mint] = PublicKey.findProgramAddressSync([seedMint, saleBytes, n], PROGRAM_ID)
    if (base58Tail(mint.toBytes(), suffix.length) === suffix) return { nonce, mint: mint.toBase58() }
  }
  return null
}

/** Grinds across every core. Resolves `{ nonce, mint, tried, seconds }`. */
export async function grind(saleKey, suffix = VANITY_SUFFIX, { workers = Math.max(1, cpus().length - 1), onProgress, hi = randomHi() } = {}) {
  const started = Date.now()
  const CHUNK = 250_000
  return new Promise((resolve, reject) => {
    let next = 0, tried = 0, done = false
    const pool = []
    const finish = (r) => {
      if (done) return
      done = true
      pool.forEach((w) => w.terminate())
      resolve({ ...r, tried, seconds: (Date.now() - started) / 1000 })
    }
    for (let i = 0; i < workers; i++) {
      const w = new Worker(new URL(import.meta.url), { workerData: { saleKey, suffix, hi } })
      pool.push(w)
      w.on('message', (m) => {
        if (m.found) return finish(m.found)
        tried += m.tried ?? 0
        onProgress?.(tried)
        if (!done) w.postMessage({ from: next, count: CHUNK }), (next += CHUNK)
      })
      w.on('error', reject)
      w.postMessage({ from: next, count: CHUNK })
      next += CHUNK
    }
  })
}

if (!isMainThread) {
  const { saleKey, suffix, hi } = workerData
  parentPort.on('message', ({ from, count }) => {
    const hit = searchRange(saleKey, suffix, from, count, hi)
    parentPort.postMessage(hit ? { found: hit } : { tried: count })
  })
}

const isCli = typeof process !== 'undefined' && Array.isArray(process.argv)
  && import.meta.url === `file://${process.argv[1]}`
if (isCli && isMainThread) {
  const sale = process.argv[2]
  if (!sale) { console.log('usage: node vanity.mjs <saleAddress> [suffix]'); process.exit(1) }
  const suffix = process.argv[3] ?? VANITY_SUFFIX
  console.log(`grinding "${suffix}" for sale ${sale} on ${Math.max(1, cpus().length - 1)} workers…`)
  let last = 0
  const r = await grind(sale, suffix, { onProgress: (t) => {
    if (t - last >= 1_000_000) { last = t; process.stdout.write(`  ${(t / 1e6).toFixed(1)}M tried\r`) }
  } })
  console.log(`\nnonce ${r.nonce}  ->  ${r.mint}`)
  console.log(`${(r.tried / 1e6).toFixed(2)}M tried in ${r.seconds.toFixed(1)}s (${Math.round(r.tried / r.seconds).toLocaleString()}/s)`)
}
