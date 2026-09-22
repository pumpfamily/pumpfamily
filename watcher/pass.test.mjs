/**
 * The watcher's pass planner, against fakes: no chain, no keys. `node watcher/pass.test.mjs`.
 *
 * What it pins: open sales are worked every pass; settled ones only on their turn and only in
 * full when something changed; the listing can never make the watcher SKIP an open sale; an
 * unreadable fingerprint, an error, or work left over all keep a sale out of `quiet`; and the
 * platform token's row is not a sale.
 */
import assert from 'node:assert/strict'
import { planPass, passOver, nothingLeft, bucketOf } from './pass.mjs'

let passed = 0
const ok = (name, cond) => { if (!cond) { console.error(`✗ ${name}`); process.exit(1) } console.log(`✓ ${name}`); passed++ }

const EVERY = 4
const row = (address, status, extra = {}) => ({ address, authority: 'auth', status, ...extra })
const FAMILY = { address: 'FAMILYMINT', mint: 'FAMILYMINT', authority: null, status: 1, featured: true }

// ── planPass ──
{
  const rows = [FAMILY, row('open1', 0), row('open2', 0), row('done1', 1), row('done2', 1), row('fail1', 2)]
  const seen = new Set()
  for (let pass = 0; pass < EVERY; pass++) {
    const p = planPass(rows, pass, EVERY)
    ok(`pass ${pass}: both open sales, every pass`, p.open.map((r) => r.address).join() === 'open1,open2')
    ok(`pass ${pass}: the family row is not a sale`, p.notSales === 1 && !p.settled.some((r) => r.address === 'FAMILYMINT'))
    p.settled.forEach((r) => seen.add(r.address))
    for (const r of p.settled) ok(`pass ${pass}: ${r.address} is in its own bucket`, bucketOf(r.address, EVERY) === pass % EVERY)
  }
  ok('every settled sale had exactly one turn over EVERY passes', [...seen].sort().join() === 'done1,done2,fail1')
  ok('a pass number past EVERY wraps', planPass(rows, EVERY + 1, EVERY).settled.length === planPass(rows, 1, EVERY).settled.length)
  ok('an empty or missing listing plans nothing', planPass(undefined, 0, EVERY).open.length === 0)
}

// ── nothingLeft ──
{
  const idle = () => ({ credited: [], returned: [] })
  const done = () => ({ launched: false, failed: false, delivered: 0, unclaimed: 0, complete: true })
  ok('idle attest + complete crank leaves nothing', nothingLeft(idle(), done()))
  ok('a credit is work', !nothingLeft({ ...idle(), credited: [1] }, done()))
  ok('a return is work', !nothingLeft({ ...idle(), returned: [1] }, done()))
  ok('a pending close is work', !nothingLeft({ ...idle(), closePending: true }, done()))
  ok('a return waiting on the owner is work', !nothingLeft({ ...idle(), waiting: 1 }, done()))
  ok('a delivery is work', !nothingLeft(idle(), { ...done(), delivered: 1 }))
  ok('an undelivered position is work', !nothingLeft(idle(), { ...done(), unclaimed: 1, complete: false }))
  ok('a launch is work', !nothingLeft(idle(), { ...done(), launched: true }))
  ok('a crank that never reached delivery is not complete', !nothingLeft(idle(), { launched: false, failed: false, delivered: 0 }))
  ok('a half that threw is never nothing', !nothingLeft(null, done()) && !nothingLeft(idle(), null))
}

// ── passOver ──
const harness = (chain) => {
  const calls = { readSale: [], readHeld: [], attest: [], crank: [], log: [] }
  const deps = {
    readSale: async (a) => { calls.readSale.push(a); const c = chain[a]; if (c?.throws) throw new Error('rpc down'); return c ? { status: c.status, depositAccount: `dep:${a}` } : null },
    readHeld: async (d) => { calls.readHeld.push(d); const c = chain[d.slice(4)]; if (c.heldThrows) throw new Error('rpc down'); return c.held },
    attest: async (a) => { calls.attest.push(a); const c = chain[a]; if (c?.attestThrows) throw new Error('attest boom'); return c?.attest ?? { credited: [], returned: [] } },
    crank: async (a) => { calls.crank.push(a); const c = chain[a]; return c?.crank ?? { launched: false, failed: false, delivered: 0, unclaimed: 0, complete: true } },
    log: (a, m) => calls.log.push(`${a}: ${m}`),
    every: EVERY,
  }
  return { calls, deps }
}
// A settled sale that comes up on pass 0 with EVERY=4, found by search so the test is not tied to the hash.
const turn0 = (() => { for (let i = 0; ; i++) { const a = `settled${i}`; if (bucketOf(a, EVERY) === 0) return a } })()
const turn1 = (() => { for (let i = 0; ; i++) { const a = `other${i}`; if (bucketOf(a, EVERY) === 1) return a } })()

{
  console.log('\n── an open sale gets the full treatment every pass, and never a fingerprint read ──')
  const { calls, deps } = harness({ open1: { status: 0 } })
  const quiet = new Map()
  for (let pass = 0; pass < 3; pass++) await passOver([FAMILY, row('open1', 0)], pass, quiet, deps)
  ok('attested three times', calls.attest.join() === 'open1,open1,open1')
  ok('cranked three times', calls.crank.join() === 'open1,open1,open1')
  ok('no fingerprint reads for an open sale', calls.readSale.length === 0 && calls.readHeld.length === 0)
  ok('the family row was never worked', !calls.attest.includes('FAMILYMINT') && !calls.readSale.includes('FAMILYMINT'))
  ok('nothing about an open sale goes quiet', quiet.size === 0)
}

{
  console.log('\n── a settled sale: full once, then two cheap reads a turn while nothing changes ──')
  const { calls, deps } = harness({ [turn0]: { status: 1, held: '0' } })
  const quiet = new Map()
  const t0 = await passOver([row(turn0, 1)], 0, quiet, deps)
  ok('pass 0 worked it in full', t0.full === 1 && calls.attest.length === 1 && calls.crank.length === 1)
  ok('it went quiet on its fingerprint', quiet.get(turn0) === '1:0')
  for (let pass = 1; pass < EVERY; pass++) {
    const t = await passOver([row(turn0, 1)], pass, quiet, deps)
    ok(`pass ${pass}: not its turn, nothing read`, t.settled === 0 && calls.readSale.length === 1)
  }
  const t4 = await passOver([row(turn0, 1)], EVERY, quiet, deps)
  ok('on its next turn: sale + balance read, no full pass', t4.settled === 1 && t4.quiet === 1 && calls.readSale.length === 2 && calls.readHeld.length === 2 && calls.attest.length === 1)
}

{
  console.log('\n── a late send changes the balance: the full pass runs, returns it, and re-quiets on the new balance ──')
  const chain = { [turn0]: { status: 1, held: '0' } }
  const { calls, deps } = harness(chain)
  const quiet = new Map([[turn0, '1:0']])
  chain[turn0].held = '5000000'
  chain[turn0].attest = { credited: [], returned: [{ amount: 5000000n }] }
  const t = await passOver([row(turn0, 1)], 0, quiet, deps)
  ok('the changed fingerprint forced a full pass', t.full === 1 && calls.attest.length === 1)
  ok('a pass that returned money does not go quiet', !quiet.has(turn0))
  chain[turn0].held = '0'; delete chain[turn0].attest
  await passOver([row(turn0, 1)], EVERY, quiet, deps)
  ok('the next turn found nothing and went quiet on the new balance', quiet.get(turn0) === '1:0' && calls.attest.length === 2)
}

{
  console.log('\n── the listing cannot hide an open sale: chain status 0 overrides a settled row ──')
  const { calls, deps } = harness({ [turn0]: { status: 0, held: '0' } })
  const quiet = new Map([[turn0, '1:0']])
  const t = await passOver([row(turn0, 1)], 0, quiet, deps)
  ok('read the chain, saw status 0, ran the full pass', t.full === 1 && calls.attest[0] === turn0)
  ok('no balance read was needed', calls.readHeld.length === 0)
  ok('a stale quiet entry is dropped, not kept', !quiet.has(turn0))
}

{
  console.log('\n── unreadable is not quiet ──')
  const { calls, deps } = harness({ [turn0]: { status: 1, held: '0', heldThrows: true } })
  const quiet = new Map([[turn0, '1:0']])
  const t = await passOver([row(turn0, 1)], 0, quiet, deps)
  ok('a balance that could not be read forces the full pass', t.full === 1 && calls.attest.length === 1)
  ok('and the sale is no longer quiet', !quiet.has(turn0))
  ok('the reason was logged', calls.log.some((l) => l.includes('settled check unreadable')))

  const h2 = harness({ [turn0]: { status: 1, held: '0', attestThrows: true } })
  const q2 = new Map()
  await passOver([row(turn0, 1)], 0, q2, h2.deps)
  ok('an attest that threw keeps the sale out of quiet, and the crank still ran', !q2.has(turn0) && h2.calls.crank.length === 1)
  ok('the failure was logged as a retry', h2.calls.log.some((l) => l.includes('attest failed, retrying next round')))
}

{
  console.log('\n── work left over keeps a settled sale awake ──')
  const chain = { [turn0]: { status: 2, held: '900', crank: { launched: false, failed: false, delivered: 0, unclaimed: 1, complete: false } } }
  const { calls, deps } = harness(chain)
  const quiet = new Map()
  await passOver([row(turn0, 2)], 0, quiet, deps)
  ok('an undelivered refund is not quiet', !quiet.has(turn0))
  chain[turn0].crank = { launched: false, failed: false, delivered: 1, unclaimed: 0, complete: true }
  await passOver([row(turn0, 2)], EVERY, quiet, deps)
  ok('the pass that delivered it is not quiet either', !quiet.has(turn0))
  chain[turn0].held = '0'; delete chain[turn0].crank
  await passOver([row(turn0, 2)], 2 * EVERY, quiet, deps)
  ok('the first idle pass after it is', quiet.get(turn0) === '2:0' && calls.attest.length === 3)
}

{
  console.log('\n── an address the chain does not hold is nothing to do ──')
  const { calls, deps } = harness({})
  const quiet = new Map()
  const t = await passOver([row(turn0, 1)], 0, quiet, deps)
  ok('no full pass, no balance read, nothing quiet', t.full === 0 && calls.readHeld.length === 0 && quiet.size === 0)
}

{
  console.log('\n── order: open sales first, then the settled slice ──')
  const { calls, deps } = harness({ open1: { status: 0 }, [turn0]: { status: 1, held: '0' } })
  await passOver([row(turn0, 1), row('open1', 0)], 0, new Map(), deps)
  ok('the open sale was attested before the settled one', calls.attest.join() === `open1,${turn0}`)
  ok('a settled sale outside its turn was not touched', (await passOver([row(turn1, 1)], 0, new Map(), deps)).settled === 0)
}

console.log(`\n${passed} checks passed`)
