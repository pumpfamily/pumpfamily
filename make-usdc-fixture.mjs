/**
 * A local USDC mint that this machine can actually mint from.
 *
 * ## Why this exists
 *
 * pump.fun whitelists exactly one quote mint in `Global`, and it is the real USDC. A launch
 * against any other mint is rejected, so a quote launch cannot be exercised locally against a
 * stand-in — the deposit half can, and `quote.test.mjs` does, but the launch half cannot.
 *
 * Cloning USDC does not help either: a cloned account keeps Circle's mint authority, and nothing
 * here can sign for it.
 *
 * So this fetches the real mint account and rewrites **one field** — the mint authority — to a
 * keypair the suite controls, then writes it as a validator fixture. Everything else about the
 * account is untouched: the address, the decimals, the supply, the freeze authority.
 *
 * ⚠ This is test infrastructure and must never leave the local validator. It exists so the
 * launch path can be tested at all, which is the alternative to shipping it untested.
 *
 *   node make-usdc-fixture.mjs
 */
import { Connection, Keypair, PublicKey } from '@solana/web3.js'
import { writeFileSync, mkdirSync, existsSync } from 'node:fs'

const USDC = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')
const OUT_DIR = 'fixtures'
const ACCOUNT_FILE = `${OUT_DIR}/usdc-mint.json`
const KEY_FILE = `${OUT_DIR}/usdc-authority.json`

const rpc = process.env.SOLANA_RPC_URL
if (!rpc) {
  console.error('set SOLANA_RPC_URL (source ~/.launchdeck/.env) — the real mint is fetched from mainnet')
  process.exit(1)
}

mkdirSync(OUT_DIR, { recursive: true })

// One authority, reused across runs, so a rebuilt fixture still matches a suite that already
// has the key. Regenerating it would silently break every test that minted with the old one.
let authority
if (existsSync(KEY_FILE)) {
  authority = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(await import('node:fs').then(m => m.readFileSync(KEY_FILE, 'utf8')))))
} else {
  authority = Keypair.generate()
  writeFileSync(KEY_FILE, JSON.stringify([...authority.secretKey]))
}

const conn = new Connection(rpc, 'confirmed')
const info = await conn.getAccountInfo(USDC)
if (!info) { console.error('could not read the USDC mint'); process.exit(1) }

const data = Buffer.from(info.data)
// SPL Mint layout: mint_authority COption<Pubkey> = 4-byte tag then 32 bytes, supply u64,
// decimals u8, is_initialized bool, freeze_authority COption<Pubkey>.
const before = data.readUInt32LE(0) === 1 ? new PublicKey(data.subarray(4, 36)).toBase58() : 'none'
data.writeUInt32LE(1, 0)                       // Some(..)
authority.publicKey.toBuffer().copy(data, 4)   // ..our key

const decimals = data[36 + 8]
if (decimals !== 6) { console.error(`expected 6 decimals, read ${decimals} — layout changed`); process.exit(1) }

writeFileSync(ACCOUNT_FILE, JSON.stringify({
  pubkey: USDC.toBase58(),
  account: {
    lamports: info.lamports,
    data: [data.toString('base64'), 'base64'],
    owner: info.owner.toBase58(),
    executable: info.executable,
    rentEpoch: 0,
  },
}, null, 1))

console.log(`wrote ${ACCOUNT_FILE}`)
console.log(`  address    ${USDC.toBase58()}  (the real one, so pump.fun's whitelist accepts it)`)
console.log(`  decimals   ${decimals}`)
console.log(`  authority  ${before}  ->  ${authority.publicKey.toBase58()}`)
console.log(`  key at     ${KEY_FILE}`)
