/**
 * Dependency advisories may only DECREASE (PD-19). `audit-baseline.json` names the advisories
 * accepted today; any advisory not in it fails this check, and one that has gone away asks for
 * the baseline to be tightened. `node check-audit.mjs` — or `--write` to tighten it now.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

const here = new URL('.', import.meta.url).pathname
const PACKAGES = { root: here, web: `${here}web/` }
const baselineUrl = new URL('./audit-baseline.json', import.meta.url)
const baseline = JSON.parse(readFileSync(baselineUrl, 'utf8'))

const advisories = (dir) => {
  let out
  try { out = execFileSync('npm', ['audit', '--omit=dev', '--json'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }) }
  catch (e) { out = e.stdout } // npm audit exits 1 when it finds anything
  const j = JSON.parse(out)
  const ids = new Set()
  for (const v of Object.values(j.vulnerabilities ?? {})) for (const via of v.via ?? []) if (via?.url) ids.add(via.url.replace('https://github.com/advisories/', ''))
  return [...ids].sort()
}

let failed = 0, loosen = 0
const next = {}
for (const [name, dir] of Object.entries(PACKAGES)) {
  const now = advisories(dir)
  const accepted = new Set(baseline[name] ?? [])
  next[name] = now
  for (const id of now) if (!accepted.has(id)) { failed++; console.error(`✗ ${name}: NEW advisory ${id} — fix it, or accept it in audit-baseline.json with the reason`) }
  for (const id of accepted) if (!now.includes(id)) { loosen++; console.log(`· ${name}: ${id} is gone — tighten the baseline (node check-audit.mjs --write)`) }
  console.log(`${name}: ${now.length} advisory id(s), ${now.length - [...now].filter((i) => !accepted.has(i)).length} accepted`)
}
if (process.argv.includes('--write')) {
  writeFileSync(baselineUrl, JSON.stringify({ ...baseline, ...next }, null, 2) + '\n')
  console.log('baseline written')
} else if (loosen && !failed) console.log('(the baseline can only tighten; re-run with --write to record the smaller set)')
if (failed) process.exit(1)
console.log('✓ no advisory beyond the accepted baseline')
