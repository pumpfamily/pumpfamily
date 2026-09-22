/**
 * Reads pump.fun's real fee schedule from the fee program.
 *
 * ⛔ `Global.creator_fee_basis_points` is NOT the fee. `buy` calls out to the fee program
 * (`pfeeUxB6…VojVZ`) and uses what `get_fees` returns, which is chosen from a TIER TABLE keyed on
 * market cap. Reading `Global` gives 95+5; the live schedule gives something else entirely, and a
 * launch budgeted off `Global` reverts on `TooMuchSolRequired`.
 *
 * The tiers live in the `FeeConfig` account, so the whole schedule can be read directly rather
 * than probed one simulation at a time.
 */
import { Connection, PublicKey } from '@solana/web3.js'

export const FEE_PROGRAM = new PublicKey('pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ')
export const PUMP_PROGRAM = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P')

/** `[b"fee_config", pump_program_id]` under the fee program. */
export function feeConfigAddress(configProgramId = PUMP_PROGRAM) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('fee_config'), configProgramId.toBuffer()], FEE_PROGRAM)[0]
}

const readFees = (d, o) => ({
  lpBps: d.readBigUInt64LE(o),
  protocolBps: d.readBigUInt64LE(o + 8),
  creatorBps: d.readBigUInt64LE(o + 16),
})
const readU128 = (d, o) => d.readBigUInt64LE(o) + (d.readBigUInt64LE(o + 8) << 64n)

/** Decodes the on-chain `FeeConfig`: flat fees plus both tier tables. */
export function decodeFeeConfig(data) {
  let o = 8
  const bump = data[o]; o += 1
  const admin = new PublicKey(data.subarray(o, o + 32)); o += 32
  const flatFees = readFees(data, o); o += 24
  const tiers = (label) => {
    const n = data.readUInt32LE(o); o += 4
    const out = []
    for (let i = 0; i < n; i++) {
      out.push({ thresholdLamports: readU128(data, o), fees: readFees(data, o + 16) })
      o += 40
    }
    return out
  }
  return { bump, admin, flatFees, feeTiers: tiers(), stableFeeTiers: tiers() }
}

export async function readFeeSchedule(connection, configProgramId = PUMP_PROGRAM) {
  const addr = feeConfigAddress(configProgramId)
  const acc = await connection.getAccountInfo(addr)
  if (!acc) throw new Error(`fee config ${addr.toBase58()} not found`)
  return { address: addr, ...decodeFeeConfig(acc.data) }
}

/**
 * The fee legs that apply at a given market cap.
 *
 * Tiers are thresholds, so the applicable one is the last whose threshold the market cap has
 * reached. Falls back to `flat_fees` below the first threshold.
 */
export function feesAtMarketCap(schedule, marketCapLamports) {
  let chosen = schedule.flatFees
  for (const t of schedule.feeTiers) {
    if (marketCapLamports >= t.thresholdLamports) chosen = t.fees
    else break
  }
  return chosen
}

/** Total bps actually charged on a trade: protocol + creator. `lp_fee_bps` is 0 on the curve. */
export const totalBps = (fees) => fees.protocolBps + fees.creatorBps

/*
 * `process` does not exist in a browser, and these modules are imported by the web app. An
 * unguarded `process.argv` here throws at module evaluation, which Vite reports as a failed hot
 * update while leaving the PREVIOUS build running: the page looks fine and is silently stale.
 */
const isCli = typeof process !== 'undefined' && Array.isArray(process.argv)
  && import.meta.url === `file://${process.argv[1]}`

if (isCli) {
  const conn = new Connection(process.env.SOLANA_RPC_URL ?? 'https://solana-rpc.publicnode.com', 'confirmed')
  const s = await readFeeSchedule(conn)
  const f = (x) => `lp ${x.lpBps} / protocol ${x.protocolBps} / creator ${x.creatorBps}  = ${totalBps(x)} bps`
  console.log('fee_config :', s.address.toBase58())
  console.log('admin      :', s.admin.toBase58())
  console.log('flat_fees  :', f(s.flatFees))
  console.log(`\nfee_tiers (${s.feeTiers.length}) — threshold is market cap:`)
  for (const t of s.feeTiers) {
    console.log(`  >= ${(Number(t.thresholdLamports) / 1e9).toFixed(4).padStart(14)} SOL   ${f(t.fees)}`)
  }
  console.log(`\nstable_fee_tiers (${s.stableFeeTiers.length})`)
  for (const t of s.stableFeeTiers) console.log(`  >= ${(Number(t.thresholdLamports) / 1e9).toFixed(4).padStart(14)} SOL   ${f(t.fees)}`)
  console.log('\n— what a Pump Family launch actually pays —')
  for (const [label, mcap] of [['curve open (27.96 SOL)', 27_960_000_000n], ['mid curve (~78 SOL)', 78_000_000_000n], ['full curve (410.9 SOL)', 410_900_000_000n]]) {
    console.log(`  ${label.padEnd(24)} -> ${totalBps(feesAtMarketCap(s, mcap))} bps`)
  }
}
