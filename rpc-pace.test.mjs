import { pacing, pacedOptions, rpsFromEnv } from './rpc-pace.mjs'
let passed = 0
const ok = (n, c, d = '') => { if (!c) { console.error(`✗ ${n} ${d}`); process.exit(1) } console.log(`✓ ${n}`); passed++ }

{
  // Twenty requests fired at once through a 10/s pace leave at least 100ms apart, and all leave.
  const mw = pacing(10)
  const times = []
  const t0 = Date.now()
  await new Promise((done) => {
    for (let i = 0; i < 20; i++) mw({ i }, {}, () => { times.push(Date.now() - t0); if (times.length === 20) done() })
  })
  ok('every request was sent', times.length === 20)
  const gaps = times.slice(1).map((t, i) => t - times[i])
  ok(`no two requests left less than ~100ms apart (min gap ${Math.min(...gaps)}ms)`, Math.min(...gaps) >= 90)
  ok(`twenty took about two seconds, not forever (${times.at(-1)}ms)`, times.at(-1) >= 1800 && times.at(-1) < 2600)
}
{
  // A request that arrives after a quiet spell goes straight out — the pace is a floor on spacing,
  // not a fixed cadence.
  const mw = pacing(10)
  await new Promise((r) => mw({}, {}, r))
  await new Promise((r) => setTimeout(r, 250))
  const t = Date.now()
  await new Promise((r) => mw({}, {}, r))
  ok('an idle pace does not delay the next request', Date.now() - t < 20)
}
{
  ok('a rate of 0 means no middleware', !('fetchMiddleware' in pacedOptions(0, { commitment: 'confirmed' })))
  ok('a positive rate adds one and keeps the rest', typeof pacedOptions(5, { commitment: 'confirmed' }).fetchMiddleware === 'function' && pacedOptions(5, { commitment: 'confirmed' }).commitment === 'confirmed')
  delete process.env.RPC_RPS
  ok('the env default applies', rpsFromEnv(5) === 5)
  process.env.RPC_RPS = '3'; ok('the env overrides it', rpsFromEnv(5) === 3)
  process.env.RPC_RPS = '0'; ok('zero disables', rpsFromEnv(5) === 0)
  process.env.RPC_RPS = 'lots'; ok('nonsense disables rather than throwing', rpsFromEnv(5) === 0)
}
console.log(`\n${passed} checks passed`)
