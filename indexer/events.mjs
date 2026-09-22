/**
 * Anchor event decoding, for the two events discovery needs.
 *
 * `emit!` writes the event as `Program data: <base64>` into the transaction's log messages: an
 * eight byte discriminator, `sha256("event:<Name>")[..8]`, then the Borsh body. Only `SaleOpened`
 * matters for discovery — everything else about a sale is read back from its account, which is
 * authoritative in a way a replayed log stream is not.
 */
import { sha256 } from '@noble/hashes/sha2.js'
import { PublicKey } from '@solana/web3.js'

const evDisc = (name) => Buffer.from(sha256(new TextEncoder().encode(`event:${name}`)).slice(0, 8))

export const SALE_OPENED = evDisc('SaleOpened')
export const LAUNCHED = evDisc('Launched')
export const SALE_FAILED = evDisc('SaleFailed')
export const DEPOSITED = evDisc('Deposited')

/** Every `Program data:` payload in a log array, as Buffers. */
export function programData(logs) {
  const out = []
  for (const line of logs ?? []) {
    const m = /^Program data: (.+)$/.exec(line)
    if (m) {
      try { out.push(Buffer.from(m[1], 'base64')) } catch { /* not ours */ }
    }
  }
  return out
}

/**
 * Sale addresses opened in this log stream.
 *
 * Reads only the first field. The rest of `SaleOpened` is duplicated in the account and would go
 * stale the moment anyone deposited, so recording it here would be inviting the two to disagree.
 */
export function salesOpened(logs) {
  const out = []
  for (const buf of programData(logs)) {
    if (buf.length >= 40 && buf.subarray(0, 8).equals(SALE_OPENED)) {
      out.push(new PublicKey(buf.subarray(8, 40)).toBase58())
    }
  }
  return out
}

/** Sales this log stream reports as terminal, so a refresh can be prioritised. */
export function salesSettled(logs) {
  const out = []
  for (const buf of programData(logs)) {
    const d = buf.subarray(0, 8)
    if (buf.length >= 40 && (d.equals(LAUNCHED) || d.equals(SALE_FAILED))) {
      out.push(new PublicKey(buf.subarray(8, 40)).toBase58())
    }
  }
  return out
}

/**
 * Deposits in this log stream, in the order the program emitted them.
 *
 * ⚠ This is the one thing here that is NOT re-readable from an account, and the module doc above
 * says why that is normally avoided: a replayed event stream drifts from the chain the moment one
 * is missed. A sale account holds only its CURRENT curve state, so a price history has no
 * authoritative source to be re-read from — the log stream is all there is.
 *
 * Two things keep a gap from becoming a lie. Rows are keyed by signature, so re-walking history is
 * idempotent rather than duplicating. And the chart anchors its final point to the account read,
 * which IS authoritative — so a missed deposit in the middle costs some shape, never the price a
 * depositor is looking at now.
 *
 * Borsh, after the 8-byte discriminator: sale(32) depositor(32) amount(u64) allocation(u64)
 * price_after(u128) = 104 bytes.
 */
export function depositsIn(logs) {
  const out = []
  for (const buf of programData(logs)) {
    if (buf.length < 104 || !buf.subarray(0, 8).equals(DEPOSITED)) continue
    out.push({
      sale: new PublicKey(buf.subarray(8, 40)).toBase58(),
      depositor: new PublicKey(buf.subarray(40, 72)).toBase58(),
      amount: buf.readBigUInt64LE(72),
      allocation: buf.readBigUInt64LE(80),
      // u128 little-endian: low 64 bits then high.
      priceAfter: buf.readBigUInt64LE(88) | (buf.readBigUInt64LE(96) << 64n),
    })
  }
  return out
}
