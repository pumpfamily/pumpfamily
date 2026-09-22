/**
 * DECISIONS.md is an audit oracle only while every `Enforced-in` still points at code that exists.
 * This reads each entry, opens each named file, and looks for each backticked symbol in it.
 * It also enforces the one ruling that has no other home (PD-16). `node check-decisions.mjs`.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const FORBIDDEN_WORDS = [/\bblinks?\b/i]
const SKIP = new Set(['node_modules', '.git', 'dist', 'target', 'test-ledger', 'data'])

const md = readFileSync(new URL('./DECISIONS.md', import.meta.url), 'utf8')
const entries = [...md.matchAll(/^### (PD-\d+) · (.+)$/gm)].map((m) => ({ id: m[1], title: m[2], at: m.index }))
let failed = 0
const bad = (m) => { failed++; console.error(`✗ ${m}`) }

const ids = entries.map((e) => e.id)
if (new Set(ids).size !== ids.length) bad('duplicate PD ids')
for (let i = 0; i < entries.length; i++) {
  const e = entries[i]
  const body = md.slice(e.at, entries[i + 1]?.at ?? md.length)
  const line = body.match(/^\*\*Enforced-in:\*\*\s*(.+)$/m)
  if (!line) { bad(`${e.id} has no Enforced-in line`); continue }
  for (const part of line[1].split(';')) {
    const m = part.trim().match(/^([^\s(]+)\s*\((.*)\)$/)
    if (!m) { bad(`${e.id}: cannot parse "${part.trim()}"`); continue }
    const [, file, syms] = m
    let text
    try { text = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8') } catch { bad(`${e.id}: ${file} does not exist`); continue }
    for (const s of [...syms.matchAll(/`([^`]+)`/g)].map((x) => x[1])) {
      if (!text.includes(s)) bad(`${e.id}: ${file} no longer contains \`${s}\``)
    }
  }
}

// PD-16, the ruling this file enforces itself.
const walk = (d, out = []) => {
  for (const e of readdirSync(d)) {
    if (SKIP.has(e)) continue
    const p = join(d, e)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(mjs|js|jsx|ts|rs|md|html|css|json|sh)$/.test(e)) out.push(p)
  }
  return out
}
for (const f of walk(new URL('.', import.meta.url).pathname.replace(/\/$/, ''))) {
  const text = readFileSync(f, 'utf8')
  for (const re of FORBIDDEN_WORDS) {
    const m = text.match(re)
    if (m && !f.endsWith('check-decisions.mjs') && !f.endsWith('DECISIONS.md')) bad(`PD-16: "${m[0]}" in ${f}`)
  }
}

if (failed) { console.error(`\n${failed} decision(s) no longer match the code`); process.exit(1) }
console.log(`✓ ${entries.length} decisions, every Enforced-in resolves, no forbidden words`)
