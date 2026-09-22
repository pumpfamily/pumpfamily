/**
 * Differential check: the Rust program and curve.mjs must agree base-unit for base-unit.
 *
 * `vectors.json` is emitted by the on-chain implementation (`cargo test -p window --lib vectors`).
 * A divergence here means the allocation the program books and the number the front end showed
 * the depositor disagree — which the depositor would only discover at claim time.
 */
import { readFileSync } from 'node:fs'
import { ShadowCurve, splitDeposit, tokensOut, VS0, VT0, RT0 } from './curve.mjs'

let rows
try { rows = JSON.parse(readFileSync(new URL('./vectors.json', import.meta.url), 'utf8')) } catch {
  console.error('vectors.json is missing. It is emitted by the Rust side of this test — generate it with:\n' +
                '  cargo +1.89.0-sbpf-solana-v1.53 test --manifest-path programs/pumpfamily/Cargo.toml --lib --locked vectors\n' +
                'then run this file again. (The file is not committed: it is the OUTPUT under test.)')
  process.exit(2)
}
let vs = VS0, vt = VT0, sold = 0n, bad = 0

rows.forEach(([gross, rCurveIn, rFeeHeld, rOut, rVs, rVt], i) => {
  const g = BigInt(gross)
  const { curveIn, feeHeld } = splitDeposit(g)
  const out = tokensOut(vs, vt, curveIn, RT0 - sold)
  vs += curveIn; vt -= out; sold += out
  const checks = [
    ['curveIn', curveIn, BigInt(rCurveIn)],
    ['feeHeld', feeHeld, BigInt(rFeeHeld)],
    ['tokensOut', out, BigInt(rOut)],
    ['virtualSol', vs, BigInt(rVs)],
    ['virtualToken', vt, BigInt(rVt)],
  ]
  for (const [name, js, rust] of checks) {
    if (js !== rust) { bad++; if (bad <= 5) console.log(`  ❌ row ${i} ${name}: js=${js} rust=${rust} (Δ ${js - rust})`) }
  }
})

console.log(bad === 0
  ? `  ✅ ${rows.length} vectors × 5 fields — Rust and JS agree exactly`
  : `  ❌ ${bad} mismatches`)
process.exit(bad ? 1 : 0)
