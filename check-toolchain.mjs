/**
 * Refuses a `Cargo.lock` the SBF toolchain cannot resolve — in under a second, instead of at the
 * end of a two-minute build.
 *
 * `cargo-build-sbf` compiles with the rustc inside Solana's platform tools (**1.79**), not the
 * one on this machine. Any `cargo test`/`check`/`build` run with the system cargo can rewrite the
 * lock to versions that rustc cannot parse, and the SBF build then fails at RESOLUTION — naming a
 * transitive crate nobody here depends on, one at a time, five times running.
 *
 * See TOOLCHAIN.md. ⚠ A crate whose manifest is not on disk cannot be judged: run `cargo fetch`
 * first, or this passes over it in silence.
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

const MAX = [1, 79]

const registries = (() => {
  const out = []
  for (const kind of ['src', 'cache']) {
    const base = join(homedir(), '.cargo', 'registry', kind)
    if (!existsSync(base)) continue
    for (const d of readdirSync(base)) out.push(join(base, d))
  }
  return out
})()

/** The crate's `Cargo.toml`, from extracted source or straight out of the `.crate` archive. */
function manifest(name, version) {
  for (const r of registries) {
    const src = join(r, `${name}-${version}`, 'Cargo.toml')
    if (existsSync(src)) return readFileSync(src, 'utf8')
    const crate = join(r, `${name}-${version}.crate`)
    if (existsSync(crate)) {
      try {
        // ⚠ Read from the archive rather than unpacking it: unpacking into the registry is
        // cargo's business, and a half-written directory there is worse than a missed check.
        return execFileSync('tar', ['-xOzf', crate, `${name}-${version}/Cargo.toml`], {
          encoding: 'utf8', maxBuffer: 8 << 20,
        })
      } catch { /* a truncated or unreadable archive is "unknown", not "fine" */ }
    }
  }
  return null
}

const lock = readFileSync(new URL('./Cargo.lock', import.meta.url), 'utf8')
const pkgs = [...lock.matchAll(/\[\[package\]\]\nname = "([^"]+)"\nversion = "([^"]+)"/g)]
  .map((m) => [m[1], m[2]])

const bad = []
let unknown = 0
for (const [name, version] of pkgs) {
  const t = manifest(name, version)
  if (t === null) { unknown++; continue }
  if (/^\s*edition\s*=\s*"2024"/m.test(t)) { bad.push([name, version, 'edition2024']); continue }
  const rv = /^\s*rust-version\s*=\s*"([\d.]+)"/m.exec(t)
  if (rv) {
    const [maj, min = 0] = rv[1].split('.').map(Number)
    if (maj > MAX[0] || (maj === MAX[0] && min > MAX[1])) bad.push([name, version, `rustc ${rv[1]}`])
  }
}

console.log(`${pkgs.length} packages in the lock · ${unknown} not on disk (run \`cargo fetch\`)`)
if (!bad.length) {
  console.log(`✅ every package the SBF toolchain must parse is within rustc ${MAX.join('.')}`)
  process.exit(0)
}
console.log(`❌ ${bad.length} package(s) the SBF toolchain (rustc ${MAX.join('.')}) cannot use:\n`)
for (const [n, v, why] of bad) console.log(`   ${n}@${v}  (${why})`)
console.log('\nPin each one down, oldest blocker first — see TOOLCHAIN.md:')
console.log(`   cargo update -p ${bad[0][0]}@${bad[0][1]} --precise <older>`)
process.exit(1)
