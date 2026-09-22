/**
 * Compute units the heaviest instruction actually burns, read off the chain rather than estimated.
 *
 * Exists because binary size and compute units pull in opposite directions, and the deploy rent is
 * proportional to size. Measured 28 Aug 2026: `opt-level = "z"` saved 44,728 bytes (~0.31 SOL,
 * refundable) and cost +22,835 CU (+10.1%) on every launch forever. Reverted. Re-measure here
 * before believing any future claim that shrinking the program is free.
 *
 *   node cu-check.mjs      (after a run against ./validator.sh)
 */
import { Connection, PublicKey } from '@solana/web3.js'
import { PROGRAM_ID } from './program.mjs'
const conn = new Connection('http://127.0.0.1:8999', 'confirmed')
const sigs = await conn.getSignaturesForAddress(PROGRAM_ID, { limit: 60 })
let best = null
for (const s of sigs) {
  if (s.err) continue
  const tx = await conn.getTransaction(s.signature, { maxSupportedTransactionVersion: 0 })
  const logs = tx?.meta?.logMessages ?? []
  const line = logs.find(l => l.includes(PROGRAM_ID.toBase58()) && l.includes('consumed'))
  if (!line) continue
  const m = line.match(/consumed (\d+) of (\d+)/)
  if (!m) continue
  const used = Number(m[1])
  if (!best || used > best.used) best = { used, budget: Number(m[2]), sig: s.signature }
}
console.log(best ? `heaviest instruction: ${best.used} CU of ${best.budget}` : 'no CU lines found')
