/**
 * Creates the shared address lookup table a quote (USDC) launch is sent with.
 *
 * ## Why this exists at all
 *
 * A launch takes thirty accounts. That is close to a kilobyte of keys before any
 * instruction data, against a 1,232-byte transaction limit — so the launch **cannot be built as a
 * legacy transaction at all**. With this table it serialises to 787 bytes.
 *
 * `launchLookupAddresses()` returns the 33 accounts that are identical for every launch of
 * a given quote mint, so **one table serves every sale**. It is deployment infrastructure, created
 * once per cluster and per quote mint, not something a launch creates for itself.
 *
 * ## ⛔ Why the table is FROZEN, and why that matters more than it looks
 *
 * A v0 transaction does not commit to the accounts it will run against. It commits to the table's
 * ADDRESS and a list of INDICES into it, and the runtime resolves those indices against whatever
 * the table holds **at execution time**. So an authority that can still edit the table can change
 * which accounts an already-signed transaction resolves to, in the window between signing and
 * execution.
 *
 * Most of that is caught downstream — our own sale, vault and mint are validated by seeds in the
 * program's own `Accounts` struct and cannot be swapped, and pump.fun rejects a wrong PDA itself.
 * But the fee legs (`FEE_RECIPIENT`, `BUYBACK` and their token accounts) are passed through, and
 * this is a table every launch depends on. A mutable one is a standing trust assumption in shared
 * infrastructure for no benefit whatsoever.
 *
 * Freezing is permanent and free, and it removes the assumption entirely. The cost is the honest
 * one: **a frozen table can never be extended.** If pump.fun ever changes one of these thirty-three
 * accounts, the answer is a NEW table and a new `VITE_LAUNCH_LUT`, not an edit. That is the right
 * trade — the addresses are program IDs and PDAs that do not move, and a table that cannot be
 * quietly altered is worth more than one that can be patched.
 *
 * ## Usage
 *
 *   node make-lookup-table.mjs --rpc http://127.0.0.1:8999          # create, verify, freeze
 *   node make-lookup-table.mjs --verify <address>                   # check an existing one
 *   node make-lookup-table.mjs --rpc <mainnet> --yes                # mainnet needs --yes
 *
 * ⚠ `--verify` is the one to run before trusting a table you did not just create: it re-derives
 * all of them and compares them, so a table pointing somewhere unexpected fails here
 * rather than at launch time.
 */
import {
  Connection, Keypair, PublicKey, Transaction, AddressLookupTableProgram,
  sendAndConfirmTransaction,
} from '@solana/web3.js'
import { TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { launchLookupAddresses, USDC_MINT } from './program.mjs'

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1]
    : (i >= 0 ? true : fallback)
}
const has = (name) => process.argv.includes(`--${name}`)

const RPC = arg('rpc', process.env.LOCAL_RPC ?? 'http://127.0.0.1:8999')
const QUOTE_MINT = new PublicKey(arg('quote-mint', USDC_MINT.toBase58()))
const PAYER_PATH = arg('payer', `${homedir()}/.config/solana/id.json`)
const NO_FREEZE = has('no-freeze')

const conn = new Connection(RPC, 'confirmed')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** The addresses this table must contain, re-derived rather than trusted. */
const expected = launchLookupAddresses(QUOTE_MINT, TOKEN_PROGRAM_ID)

/**
 * Compares a live table against the derivation, address by address and in order.
 *
 * Order is checked as well as membership. It does not have to match for a transaction to work —
 * indices are resolved per transaction — but a table whose contents drifted from this function's
 * output is a table built by something other than this script, and that is worth knowing.
 */
async function verify(address) {
  const account = (await conn.getAddressLookupTable(new PublicKey(address))).value
  if (!account) return { ok: false, why: `no lookup table at ${address} on ${RPC}` }

  const got = account.state.addresses.map((a) => a.toBase58())
  const want = expected.map((a) => a.toBase58())
  if (got.length !== want.length) {
    return { ok: false, why: `holds ${got.length} addresses, expected ${want.length}`, account }
  }
  for (let i = 0; i < want.length; i++) {
    if (got[i] !== want[i]) {
      return { ok: false, why: `slot ${i}: has ${got[i]}, expected ${want[i]}`, account }
    }
  }
  // `authority` is undefined once a table is frozen — that is how freezing presents on read.
  const frozen = !account.state.authority
  return { ok: true, frozen, account }
}

if (has('verify')) {
  const address = arg('verify')
  if (address === true) {
    console.error('--verify needs the table address')
    process.exit(1)
  }
  console.log(`\nverifying ${address}\n  rpc        ${RPC}\n  quote mint ${QUOTE_MINT.toBase58()}\n`)
  const r = await verify(address)
  if (!r.ok) {
    console.error(`✗ ${r.why}`)
    process.exit(1)
  }
  console.log(`✓ all ${expected.length} addresses match the derivation`)
  console.log(r.frozen
    ? '✓ the table is FROZEN — its contents can never change'
    : '⚠ the table is MUTABLE. Its authority can change which accounts a signed launch resolves\n' +
      '  to. Freeze it, or replace it with one that is frozen.')
  process.exit(r.frozen ? 0 : 1)
}

// ── creating ──────────────────────────────────────────────────────────────────────────────────

// ⛔ Creating one of these on mainnet spends real SOL and produces an address that then has to be
// configured everywhere. It is cheap, but it is not reversible into a refund, and a second table
// created by accident is indistinguishable from the first at a glance.
const isMainnet = /mainnet|helius|quicknode|alchemy/i.test(RPC) && !/127\.0\.0\.1|localhost/.test(RPC)
if (isMainnet && !has('yes')) {
  console.error(`\nRefusing to create a lookup table on what looks like mainnet:\n  ${RPC}\n`)
  console.error('Pass --yes if that is genuinely what you want. Check first whether a table')
  console.error('already exists — `--verify <address>` is non-destructive and costs nothing.\n')
  process.exit(1)
}

let payer
try {
  payer = Keypair.fromSecretKey(new Uint8Array(JSON.parse(readFileSync(PAYER_PATH, 'utf8'))))
} catch (e) {
  console.error(`\nCould not read a keypair from ${PAYER_PATH}: ${e.message}`)
  console.error('Pass --payer <path to a solana keypair json>.\n')
  process.exit(1)
}

const rent = await conn.getMinimumBalanceForRentExemption(56 + 32 * expected.length)
const balance = await conn.getBalance(payer.publicKey)

console.log(`
creating the shared launch lookup table
  rpc        ${RPC}
  quote mint ${QUOTE_MINT.toBase58()}
  payer      ${payer.publicKey.toBase58()}  (${(balance / 1e9).toFixed(4)} SOL)
  addresses  ${expected.length}
  rent       ~${(rent / 1e9).toFixed(5)} SOL
  freeze     ${NO_FREEZE ? 'NO  ⚠ the table will stay mutable' : 'yes'}
`)

if (balance < rent + 10_000_000) {
  console.error(`Payer holds ${(balance / 1e9).toFixed(4)} SOL; needs about ${((rent + 10_000_000) / 1e9).toFixed(4)}.`)
  process.exit(1)
}

const send = (ixs) =>
  sendAndConfirmTransaction(conn, new Transaction().add(...ixs), [payer], { commitment: 'confirmed' })

// ⚠ `recentSlot` must be a slot the cluster has actually finalized. Too old and the create fails
// with "is not a recent slot", which reads like a bug in the address derivation rather than a
// staleness problem — so it is read immediately before use.
const slot = await conn.getSlot('finalized')
const [createIx, lut] = AddressLookupTableProgram.createLookupTable({
  authority: payer.publicKey, payer: payer.publicKey, recentSlot: slot,
})
await send([createIx])
console.log(`  created  ${lut.toBase58()}`)

// ⚠ In chunks of fifteen. The bound is the TRANSACTION SIZE, not a protocol constant: each
// address is 32 bytes on the wire, so the list for a create_v2 launch plus the swap venue (33 addresses,
// 992 bytes) does not fit in one extend and fails with `Transaction too large: 1242 > 1232`.
for (let i = 0; i < expected.length; i += 15) {
  await send([AddressLookupTableProgram.extendLookupTable({
    payer: payer.publicKey, authority: payer.publicKey, lookupTable: lut, addresses: expected.slice(i, i + 15),
  })])
}
console.log(`  extended with ${expected.length} addresses`)

// A table is only usable one slot after the extend that filled it.
await sleep(1500)

// ⛔ Verify BEFORE freezing. Freezing is irreversible, so a table frozen with the wrong contents
// is dead SOL and has to be replaced — the check is worth the extra round trip.
const check = await verify(lut)
if (!check.ok) {
  console.error(`\n✗ the table does not match the derivation: ${check.why}`)
  console.error('  NOT freezing it. Investigate before using this address.\n')
  process.exit(1)
}
console.log(`  verified all ${expected.length} addresses against the derivation`)

if (!NO_FREEZE) {
  await send([AddressLookupTableProgram.freezeLookupTable({
    lookupTable: lut, authority: payer.publicKey,
  })])
  const after = await verify(lut)
  if (!after.frozen) {
    console.error('\n✗ the freeze did not take. The table is still mutable — do not use it.\n')
    process.exit(1)
  }
  console.log('  frozen — its contents can never change')
}

console.log(`
✅ done.

Put this in the web build's environment:

  VITE_LAUNCH_LUT=${lut.toBase58()}

⚠ Re-deploy the front end afterwards (./deploy.sh). Until it carries this, the sale page disables
the launch button on a quote sale and says why, rather than offering one that throws.

Check it any time, from anywhere, without spending anything:

  node make-lookup-table.mjs --rpc ${RPC} --verify ${lut.toBase58()}
`)
