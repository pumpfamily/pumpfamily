/**
 * Custom pairs, end to end, on the local validator: a sale opened against one of pump.fun's
 * custom liquidity tokens → buyers send USDC from FOMO → the attester credits → the window closes →
 * USDC → SOL (Raydium) → SOL → pair token (Jupiter, a real route through a real cloned PumpSwap
 * pool) → `launch_pair` makes the coin paired with that token → every buyer is paid.
 *
 * Twice: CATE is a Token-2022 pair token, TROLL a classic SPL one, and pump.fun needs each one's
 * own token program — the suite checks each token's real owner before it relies on the label.
 *
 *   ./run-integration.sh      (validator.sh clones what fixtures/make-pair-route.mjs listed)
 */
import {
  Connection, Keypair, PublicKey, Transaction, AddressLookupTableProgram, sendAndConfirmTransaction,
} from '@solana/web3.js'
import {
  mintTo, getOrCreateAssociatedTokenAccount, getAccount, createTransferCheckedInstruction,
  getAssociatedTokenAddressSync, createMint,
} from '@solana/spl-token'
import { readFileSync } from 'node:fs'
import {
  buildInitializeSaleTx, initializeSaleIx, depositAccountSetupIxs, launchLookupAddresses, decodeSale,
  saleAddress, vaultAddress, positionAddress, decodePosition, deliverable, USDC_MINT, TOKEN_2022,
  setPairIx, readPair, readPairList, launchIx, swapToPairIx, jupiterPairRoute, QUOTE_CONTROL,
} from './program.mjs'
import { TEST_ATTESTER, TEST_FOMO_COSIGNER } from './fixtures/keys.mjs'
import { PAIR_TESTS, PAIR_ROUTE_QUERY } from './fixtures/pair-tests.mjs'
import { attestSale, crankSale, chainTime } from './watcher/attester.mjs'
import { bondingCurveAddress, decodeBondingCurve } from './market.mjs'

const RPC = process.env.LOCAL_RPC ?? 'http://127.0.0.1:8999'
const conn = new Connection(RPC, 'confirmed')
const USDC = (n) => BigInt(Math.round(n * 1e6))
const SOL = (n) => Math.round(n * 1e9)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let pass = 0, fail = 0
const ok = (n, c, d = '') => { c ? (pass++, console.log('  ✅', n)) : (fail++, console.log('  ❌', n, d)) }
const why = (e) => `${e?.message ?? e} ${JSON.stringify(e?.logs ?? e?.transactionLogs ?? [])}`
const send = (ixs, signers) => sendAndConfirmTransaction(conn, new Transaction().add(...ixs), signers, { commitment: 'confirmed' })
const fund = async (pk, n) => conn.confirmTransaction(await conn.requestAirdrop(pk, SOL(n)), 'confirmed')
const refused = async (label, fn, pattern) => {
  try { await fn(); ok(label, false, 'it was accepted') } catch (e) { ok(label, pattern.test(why(e)), why(e).slice(0, 400)) }
}
const waitUntil = async (t) => { while ((await chainTime(conn)) < t) await sleep(1000) }
const log = (m) => console.log('     ·', m)

const usdcAuthority = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync('fixtures/usdc-authority.json', 'utf8'))))
const authority = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync('fixtures/pair-authority-TEST.json', 'utf8'))))
const attester = TEST_ATTESTER
const fomo = TEST_FOMO_COSIGNER
await Promise.all([usdcAuthority, attester, fomo, authority].map((k) => fund(k.publicKey, 20)))

async function buyer(usdc) {
  const w = Keypair.generate()
  await fund(w.publicKey, 0.01)
  const ata = await getOrCreateAssociatedTokenAccount(conn, usdcAuthority, USDC_MINT, w.publicKey)
  await mintTo(conn, usdcAuthority, USDC_MINT, ata.address, usdcAuthority, Number(USDC(usdc)))
  return w
}
const fomoSend = (from, to, amount) => {
  const tx = new Transaction().add(createTransferCheckedInstruction(
    getAssociatedTokenAddressSync(USDC_MINT, from.publicKey), USDC_MINT, to, from.publicKey, amount, 6))
  tx.feePayer = fomo.publicKey
  return sendAndConfirmTransaction(conn, tx, [fomo, from], { commitment: 'confirmed' })
}

const base = (creator) => ({
  launchWindow: 3600, perWalletCap: SOL(20), hardCap: SOL(86), minRaise: 0n,
  protocolFeeBps: 95, creatorFeeBps: 30, creatorFeeRecipient: creator,
  name: 'Pair Coin', symbol: 'PAIR', uri: 'https://pump.family/demo.json', quote: 'usdc', quoteMint: USDC_MINT,
})

console.log('\n── pump.fun\'s custom-pair list is on this chain ──')
const list = await readPairList(conn)
ok(`quote-control lists ${list.length} pair tokens`, list.length > 100)
for (const t of PAIR_TESTS) ok(`${t.symbol} is on it`, list.some((e) => e.mint.toBase58() === t.mint))

console.log('\n── the shared launch lookup table ──')
let lut
{
  const auth = Keypair.generate(); await fund(auth.publicKey, 2)
  const [create, address] = AddressLookupTableProgram.createLookupTable({
    authority: auth.publicKey, payer: auth.publicKey, recentSlot: await conn.getSlot('finalized') })
  await send([create], [auth])
  // ⭐ The table the mainnet launch uses, unchanged — a pair launch must fit WITHOUT a new one.
  const addrs = launchLookupAddresses(USDC_MINT)
  for (let i = 0; i < addrs.length; i += 15) {
    await send([AddressLookupTableProgram.extendLookupTable({
      payer: auth.publicKey, authority: auth.publicKey, lookupTable: address, addresses: addrs.slice(i, i + 15) })], [auth])
  }
  await sleep(1500)
  lut = (await conn.getAddressLookupTable(address)).value
}

// ⚠ Jupiter's own lookup tables cannot be used here: cloned from mainnet, their entries activate at
// a mainnet slot this validator will not reach for years. A local table holding the same route
// accounts stands in for them; on mainnet the watcher uses Jupiter's.
let routeLut
{
  const auth = Keypair.generate(); await fund(auth.publicKey, 2)
  const [create, address] = AddressLookupTableProgram.createLookupTable({
    authority: auth.publicKey, payer: auth.publicKey, recentSlot: await conn.getSlot('finalized') })
  await send([create], [auth])
  const route = JSON.parse(readFileSync('fixtures/pair-route-accounts.json', 'utf8'))
  const have = new Set(lut.state.addresses.map((a) => a.toBase58()))
  const addrs = [...route.programs, ...route.accounts].filter((a) => !have.has(a)).map((a) => new PublicKey(a))
  for (let i = 0; i < addrs.length; i += 20) {
    await send([AddressLookupTableProgram.extendLookupTable({
      payer: auth.publicKey, authority: auth.publicKey, lookupTable: address, addresses: addrs.slice(i, i + 20) })], [auth])
  }
  await sleep(1500)
  routeLut = (await conn.getAddressLookupTable(address)).value
}
const JUP = { query: PAIR_ROUTE_QUERY, slippageBps: 300, tables: [routeLut] }

console.log('\n── what naming a pair refuses ──')
{
  const c = Keypair.generate(); await fund(c.publicKey, 2)
  const open = async (saleId, extra) => {
    const dw = Keypair.generate()
    const sale = saleAddress(c.publicKey, saleId)
    const { ix } = initializeSaleIx(c.publicKey, saleId, { ...base(c.publicKey), windowSeconds: 600, depositWallet: dw.publicKey })
    return send([...depositAccountSetupIxs(c.publicKey, dw.publicKey, vaultAddress(sale)), ix, ...extra(sale)], [c, dw])
  }
  const cate = new PublicKey(PAIR_TESTS[0].mint)
  const fake = await createMint(conn, c, c.publicKey, null, 6)
  await refused('a token pump.fun does not list is refused', () => open(11n, (s) => [setPairIx(c.publicKey, s, fake, 0)]), /PairNotListed/)
  await refused('USDC is not a custom pair', () => open(12n, (s) => [setPairIx(c.publicKey, s, USDC_MINT, 0)]), /PairNotListed/)
  await refused('a creator fee above pump.fun\'s 3% is refused', async () => {
    const ix = setPairIx(c.publicKey, saleAddress(c.publicKey, 13n), cate, 0)
    ix.data.writeBigUInt64LE(301n, 8)
    return open(13n, () => [ix])
  }, /PairCreatorFeeTooHigh/)
  await refused('only the sale\'s own authority may name its pair', async () => {
    await open(14n, () => [])
    const other = Keypair.generate(); await fund(other.publicKey, 1)
    const ix = setPairIx(other.publicKey, saleAddress(c.publicKey, 14n), cate, 0)
    return send([ix], [other])
  }, /NotAuthority|ConstraintAddress/)
  await refused('a sale cannot be opened as a pair sale without naming the pair', async () => {
    const dw = Keypair.generate(), sale = saleAddress(c.publicKey, 15n)
    const { ix } = initializeSaleIx(c.publicKey, 15n, { ...base(c.publicKey), windowSeconds: 600, quote: 'usdcPair', depositWallet: dw.publicKey })
    return send([...depositAccountSetupIxs(c.publicKey, dw.publicKey, vaultAddress(sale)), ix], [c, dw])
  }, /WrongQuote/)
}

for (const t of PAIR_TESTS) {
  console.log(`\n══ a sale paired with ${t.symbol} (${t.mint.slice(0, 8)}…, creator fee ${t.creatorFeeBps} bps) ══`)
  const pairMint = new PublicKey(t.mint)
  const pairProgram = (await conn.getAccountInfo(pairMint)).owner
  ok(`${t.symbol} really is ${t.program}`, pairProgram.toBase58() === (t.program === 'Token-2022' ? TOKEN_2022.toBase58() : 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'), pairProgram.toBase58())
  const depositWallet = Keypair.generate()
  const { sale, vault, depositAccount, tx } = await buildInitializeSaleTx(conn, authority.publicKey, t.saleId, {
    ...base(authority.publicKey), windowSeconds: 60, pairMint, pairCreatorFeeBps: t.creatorFeeBps,
  }, depositWallet)
  tx.partialSign(authority)
  await conn.confirmTransaction(await conn.sendRawTransaction(tx.serialize()), 'confirmed')

  {
    const s = decodeSale((await conn.getAccountInfo(sale)).data)
    const p = await readPair(conn, sale)
    ok('opened in one transaction, as a pair sale that still takes USDC', s.pair && s.quoteLabel === 'usdc')
    ok('the pair is recorded with its own token program', p?.mint.equals(pairMint) && p.tokenProgram.equals(pairProgram))
    ok('and the creator fee pump.fun will be given', p?.creatorFeeBps === t.creatorFeeBps)
  }
  await refused('the pair cannot be changed once named', () => send([setPairIx(authority.publicKey, sale, pairMint, 0)], [authority]), /already in use|0x0/)

  const alice = await buyer(300), bob = await buyer(300)
  await fomoSend(alice, depositAccount, USDC(40))
  await fomoSend(bob, depositAccount, USDC(25))
  await attestSale(conn, attester, sale, { fomoCosigner: fomo.publicKey, settleSeconds: 3, log })
  {
    const s = decodeSale((await conn.getAccountInfo(sale)).data)
    ok('both FOMO sends credited, priced on the SOL shadow curve as before', s.gross === USDC(65) && s.depositors === 2 && s.sold > 0n)
  }

  const s0 = decodeSale((await conn.getAccountInfo(sale)).data)
  // Past the window AND the attester's settle delay, so it closes crediting.
  await waitUntil(Number(s0.windowEnd) + 5)
  await attestSale(conn, attester, sale, { fomoCosigner: fomo.publicKey, settleSeconds: 3, log })

  // The permissionless SOL launch must refuse a sale that promised a pair token.
  {
    const s = decodeSale((await conn.getAccountInfo(sale)).data)
    const k = Keypair.generate(); await fund(k.publicKey, 1)
    await refused('the ordinary SOL launch refuses a pair sale, whoever calls it', async () => {
      const { VersionedTransaction, TransactionMessage, ComputeBudgetProgram } = await import('@solana/web3.js')
      const msg = new TransactionMessage({ payerKey: k.publicKey, recentBlockhash: (await conn.getLatestBlockhash()).blockhash,
        instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }), launchIx(k.publicKey, sale, vault, 1n, s.creatorFeeRecipient, false)] })
        .compileToV0Message([lut])
      const vt = new VersionedTransaction(msg); vt.sign([k])
      const sig = await conn.sendTransaction(vt, { skipPreflight: false })
      await conn.confirmTransaction(sig, 'confirmed')
    }, /PairSale/)
  }

  // Someone other than the attester cannot route the swap — the route is theirs to choose.
  {
    const k = Keypair.generate(); await fund(k.publicKey, 1)
    const p = await readPair(conn, sale)
    const { route, minOut, lookupTables } = await jupiterPairRoute(vault, p, 1_000_000_000n, { query: PAIR_ROUTE_QUERY, slippageBps: 300 })
    await refused('only the attester may swap into the pair', async () => {
      const { VersionedTransaction, TransactionMessage } = await import('@solana/web3.js')
      const tables = [lut, routeLut]
      const msg = new TransactionMessage({ payerKey: k.publicKey, recentBlockhash: (await conn.getLatestBlockhash()).blockhash,
        instructions: [swapToPairIx(k.publicKey, sale, vault, depositAccount, p, route, minOut)] }).compileToV0Message(tables)
      const vt = new VersionedTransaction(msg); vt.sign([k])
      await conn.confirmTransaction(await conn.sendTransaction(vt), 'confirmed')
    }, /NotAttester|ConstraintAddress/)
  }

  // The watcher's own crank: swap to SOL, swap to the pair, launch_pair, deliver.
  let done
  for (let i = 0; i < 4; i++) {
    try {
      done = await crankSale(conn, attester, sale, { lookupTable: lut, fomoCosigner: fomo.publicKey, log,
        jupiter: JUP })
      if (decodeSale((await conn.getAccountInfo(sale)).data).status === 1) break
    } catch (e) { log(`crank retry ${i + 1}: ${why(e).slice(0, 600)}`); await sleep(1500) }
  }
  const s = decodeSale((await conn.getAccountInfo(sale)).data)
  const p = await readPair(conn, sale)
  ok('the sale launched', s.status === 1, s.statusLabel)
  ok('the raise was swapped to SOL and then into the pair token', s.solIn > 0n && p.pairIn > 0n, `${s.solIn} / ${p?.pairIn}`)
  if (s.status !== 1) { console.log(`\n${pass} passed, ${fail} failed`); process.exit(1) }

  const curve = decodeBondingCurve((await conn.getAccountInfo(bondingCurveAddress(s.mint))).data)
  ok(`pump.fun made the coin paired with ${t.symbol}`, curve.quoteMint?.equals(pairMint), curve.quoteMint?.toBase58())
  ok(`with the creator fee the creator chose (${t.creatorFeeBps} bps)`, curve.creatorFeeBps === BigInt(t.creatorFeeBps), String(curve.creatorFeeBps))
  ok('the coin ends in fomo, like every Pump Family coin', s.mint.toBase58().endsWith('fomo'))
  const vaultPair = await getAccount(conn, getAssociatedTokenAddressSync(pairMint, vault, true, pairProgram), 'confirmed', pairProgram)
  ok('every unit of the pair token went into the curve', vaultPair.amount === 0n, String(vaultPair.amount))
  const curvePair = await getAccount(conn, getAssociatedTokenAddressSync(pairMint, bondingCurveAddress(s.mint), true, pairProgram), 'confirmed', pairProgram)
  ok('and the curve holds it', curvePair.amount > 0n && curvePair.amount <= p.pairIn)
  ok('no SOL of the raise stayed behind in the vault',
     (await conn.getBalance(vault)) < 45_000_000 + 5_000_000, String(await conn.getBalance(vault)))

  for (const [name, w] of [['alice', alice], ['bob', bob]]) {
    const pos = decodePosition((await conn.getAccountInfo(positionAddress(sale, w.publicKey))).data)
    const bal = await getAccount(conn, getAssociatedTokenAddressSync(s.mint, w.publicKey, true, TOKEN_2022), 'confirmed', TOKEN_2022).then((a) => a.amount).catch(() => 0n)
    ok(`${name} was paid exactly their scaled allocation`, pos.claimed && bal === deliverable(pos, s) && bal > 0n, `${bal} vs ${deliverable(pos, s)}`)
  }
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
