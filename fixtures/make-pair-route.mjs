/**
 * Writes `fixtures/pair-route-accounts.json`: every mainnet account a Jupiter swap from the TEST
 * pair sales' vaults into their pair tokens touches, so validator.sh can clone them.
 *
 * ⚠ The route is pinned to ONE direct PumpSwap pool per token (`onlyDirectRoutes`, `dexes=Pump.fun
 * Amm`), so the account set is the pool's own and does not change between this run and the test —
 * only the amounts do, and the test asks Jupiter again with the real amount.
 *
 *   SOLANA_RPC_URL=… node fixtures/make-pair-route.mjs
 */
import { Connection, Keypair, PublicKey } from '@solana/web3.js'
import { readFileSync, writeFileSync } from 'node:fs'
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { saleAddress, vaultAddress, jupiterPairRoute, QUOTE_CONTROL, JUPITER, WSOL_MINT } from '../program.mjs'

const PUMP_AMM = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA')
import { PAIR_TESTS, PAIR_ROUTE_QUERY } from './pair-tests.mjs'

const conn = new Connection(process.env.SOLANA_RPC_URL ?? 'https://api.mainnet-beta.solana.com', 'confirmed')
const authority = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(new URL('./pair-authority-TEST.json', import.meta.url)))))
const clone = new Set([QUOTE_CONTROL.toBase58()])
const programs = new Set()
for (const t of PAIR_TESTS) {
  const vault = vaultAddress(saleAddress(authority.publicKey, t.saleId))
  const mint = new PublicKey(t.mint)
  const tokenProgram = (await conn.getAccountInfo(mint)).owner
  // ⚠ Jupiter rotates between its sixteen program authorities (PDA ["authority", id]) from one
  // request to the next, and each has its own token accounts and its own PumpSwap volume account.
  // One request sees one of them, so the rest are DERIVED rather than sampled.
  const { route, lookupTables } = await jupiterPairRoute(vault, { mint, tokenProgram }, 1_000_000_000, { query: PAIR_ROUTE_QUERY })
  lookupTables.forEach((a) => clone.add(a))
  const keys = new Set(route.accounts.map((a) => a.pubkey))
  for (let id = 0; id < 16; id++) {
    const auth = PublicKey.findProgramAddressSync([Buffer.from('authority'), Buffer.from([id])], JUPITER)[0]
    keys.add(auth.toBase58())
    keys.add(getAssociatedTokenAddressSync(WSOL_MINT, auth, true, TOKEN_PROGRAM_ID).toBase58())
    keys.add(getAssociatedTokenAddressSync(mint, auth, true, tokenProgram).toBase58())
    keys.add(PublicKey.findProgramAddressSync([Buffer.from('user_volume_accumulator'), auth.toBuffer()], PUMP_AMM)[0].toBase58())
  }
  const list = [...keys]
  for (let i = 0; i < list.length; i += 100) {
    const chunk = list.slice(i, i + 100)
    const infos = await conn.getMultipleAccountsInfo(chunk.map((k) => new PublicKey(k)))
    chunk.forEach((k, j) => {
      if (!infos[j]) return // created on demand: the vault's own accounts, unused authorities' accounts
      if (infos[j].executable) programs.add(k)
      else clone.add(k)
    })
  }
  console.log(t.symbol, list.length, 'candidate accounts')
  clone.add(t.mint)
}
// Programs the validator already loads, or loads itself.
for (const p of ['11111111111111111111111111111111', 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
  'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA', 'pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ',
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P']) programs.delete(p)
// Accounts validator.sh already clones.
const already = readFileSync(new URL('../validator.sh', import.meta.url), 'utf8')
// The native mint is in every validator's genesis already.
clone.delete('So11111111111111111111111111111111111111112')
const out = { programs: [...programs], accounts: [...clone].filter((a) => !already.includes(`--clone ${a}`)) }
writeFileSync(new URL('./pair-route-accounts.json', import.meta.url), JSON.stringify(out, null, 1))
console.log(out.programs.length, 'programs,', out.accounts.length, 'accounts')
