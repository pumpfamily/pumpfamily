/**
 * Browser-side seed grinder. Same design as vanity.mjs: hash with bump 255, test the LAST base58
 * character first (one divmod pass rejects 57 in 58), and only pay for a real PDA derivation on a
 * candidate that already looks right.
 */
import { sha256 } from '@noble/hashes/sha2.js'
import { PublicKey } from '@solana/web3.js'

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
const MARKER = new TextEncoder().encode('ProgramDerivedAddress')
const SEED = new TextEncoder().encode('mint')

self.onmessage = (e) => {
  const { saleKey, programId, suffix, from, count, hi = 0 } = e.data
  const sale = new PublicKey(saleKey).toBytes()
  const prog = new PublicKey(programId).toBytes()

  const input = new Uint8Array(SEED.length + sale.length + 8 + 1 + prog.length + MARKER.length)
  let o = 0
  input.set(SEED, o); o += SEED.length
  input.set(sale, o); o += sale.length
  const nonceAt = o; o += 8
  input[o++] = 255
  input.set(prog, o); o += prog.length
  input.set(MARKER, o)

  const want = Array.from(suffix).reverse().map((c) => B58.indexOf(c))
  const view = new DataView(input.buffer)
  view.setUint32(nonceAt + 4, hi >>> 0, true)
  const scratch = new Uint8Array(32)

  for (let i = from; i < from + count; i++) {
    view.setUint32(nonceAt, i >>> 0, true)
    scratch.set(sha256(input))
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

    const n = new Uint8Array(8)
    new DataView(n.buffer).setUint32(0, i >>> 0, true)
    new DataView(n.buffer).setUint32(4, hi >>> 0, true)
    const nonce = new DataView(n.buffer).getBigUint64(0, true).toString()
    const [mint] = PublicKey.findProgramAddressSync([SEED, sale, n], new PublicKey(programId))
    if (mint.toBase58().endsWith(suffix)) {
      self.postMessage({ found: { nonce, mint: mint.toBase58() } })
      return
    }
  }
  self.postMessage({ tried: count })
}
