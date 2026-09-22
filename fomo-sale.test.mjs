/**
 * The whole product, end to end, on a local validator with mainnet's pump.fun cloned:
 *
 *   a creator opens a sale from an ordinary wallet → buyers SEND USDC to its deposit address →
 *   the attester credits what FOMO co-signed and returns everything else → the window closes →
 *   the sale launches on pump.fun → tokens are pushed to every buyer. And the failure path:
 *   the minimum is missed → the sale fails → every deposit is pushed back.
 *
 * FOMO's co-signer is played by `fixtures/fomo-cosigner-TEST.json`, exactly the way FOMO's app
 * uses the real one: as fee payer and second signer on a plain USDC transfer.
 *
 *   ./run-integration.sh     (builds with --features test-attester and runs this)
 */
import {
  Connection, Keypair, PublicKey, Transaction, AddressLookupTableProgram, sendAndConfirmTransaction,
  TransactionMessage, VersionedTransaction, ComputeBudgetProgram, SystemProgram,
} from '@solana/web3.js'
import {
  mintTo, getOrCreateAssociatedTokenAccount, getAccount, createTransferCheckedInstruction,
  getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID, createMint, createAssociatedTokenAccountIdempotentInstruction,
} from '@solana/spl-token'
import { readFileSync } from 'node:fs'
import {
  PROGRAM_ID, initializeSaleIx, buildInitializeSaleTx, mintAddress, depositAccountSetupIxs, launchLookupAddresses,
  decodeSale, saleAddress, vaultAddress, positionAddress, decodePosition, USDC_MINT, TOKEN_2022,
  creditIx, returnTransferIx, launchIx, swapToSolIx, SWAP_POOL, SWAP_MARKET, poolVaults, WSOL_MINT,
  isProgramSale, refundPushIx, refundSolIx, failSaleIx, sweepLamportsIx, buildClaimQuoteTx,
} from './program.mjs'
import { grind } from './vanity.mjs'
import { TEST_ATTESTER, TEST_FOMO_COSIGNER } from './fixtures/keys.mjs'
import { attestSale, crankSale, chainTime, SALE_SIZE } from './watcher/attester.mjs'
import { ShadowCurve, VQ0_USDC, VS0, VT0, RT0, solEquivalent } from './curve.mjs'
import { bondingCurveAddress, decodeBondingCurve, PUMP } from './market.mjs'

const RPC = process.env.LOCAL_RPC ?? 'http://127.0.0.1:8999'
const conn = new Connection(RPC, 'confirmed')
const USDC = (n) => BigInt(Math.round(n * 1e6))
const SOL = (n) => Math.round(n * 1e9)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let pass = 0, fail = 0
/** The swap pool's vaults, read off the pool account itself — what every credit has to carry. */
let POOL = null
const pool = async () => (POOL ??= poolVaults((await conn.getAccountInfo(SWAP_POOL)).data))
const ok = (n, c, d = '') => { c ? (pass++, console.log('  ✅', n)) : (fail++, console.log('  ❌', n, d)) }
const why = (e) => `${e?.message ?? e} ${JSON.stringify(e?.logs ?? e?.transactionLogs ?? [])}`
const send = (ixs, signers) => sendAndConfirmTransaction(conn, new Transaction().add(...ixs), signers, { commitment: 'confirmed' })
const fund = async (pk, n) => conn.confirmTransaction(await conn.requestAirdrop(pk, SOL(n)), 'confirmed')
const refused = async (label, fn, pattern) => {
  try { await fn(); ok(label, false, 'it was accepted') } catch (e) { ok(label, pattern.test(why(e)), why(e).slice(0, 400)) }
}
const usdcOf = async (owner) => {
  try { return (await getAccount(conn, getAssociatedTokenAddressSync(USDC_MINT, owner))).amount } catch { return 0n }
}
const tokensOf = async (owner, mint) => {
  // ⛔ Token-2022: the coin is made with pump.fun's `create_v2`, and the ATA address differs by
  // program — reading the classic one returns 0 for a wallet that is correctly paid.
  try { return (await getAccount(conn, getAssociatedTokenAddressSync(mint, owner, true, TOKEN_2022), 'confirmed', TOKEN_2022)).amount } catch { return 0n }
}
const waitUntil = async (t) => { while ((await chainTime(conn)) < t) await sleep(1000) }

/**
 * Cranks until it converges, the way the service does — every 15 seconds, forever.
 *
 * ⚠ **One pass is not the contract.** `positionsOf` REFUSES a partial read of the deposit history
 * rather than delivering to a subset and reporting success, so a validator that has not caught up
 * raises instead of silently delivering nothing. A test that demands a single pass is therefore
 * stricter than the product, and fails on the validator rather than on the code — which is
 * exactly what it did, at the grief section, on a re-run against a long-lived validator.
 */
const crankUntil = async (sale, attempts = 5) => {
  let last
  for (let i = 0; i < attempts; i++) {
    try { return await crankSale(conn, cranker, sale, { lookupTable: lut, fomoCosigner: fomo.publicKey, log }) }
    catch (e) { last = e; log(`crank retry ${i + 1}: ${e.message}`); await sleep(1500) }
  }
  throw last
}

const usdcAuthority = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync('fixtures/usdc-authority.json', 'utf8'))))
const attester = TEST_ATTESTER
const fomo = TEST_FOMO_COSIGNER
const cranker = Keypair.generate()
await Promise.all([usdcAuthority, attester, fomo, cranker].map((k) => fund(k.publicKey, 20)))

/** A wallet holding USDC and no SOL at all — like a FOMO user. */
async function buyer(usdc) {
  const w = Keypair.generate()
  await fund(w.publicKey, 0.01) // only for the Phantom-style sender, which pays its own fee
  const ata = await getOrCreateAssociatedTokenAccount(conn, usdcAuthority, USDC_MINT, w.publicKey)
  await mintTo(conn, usdcAuthority, USDC_MINT, ata.address, usdcAuthority, Number(USDC(usdc)))
  return w
}
/** A send from the FOMO app: FOMO pays the fee and co-signs. */
const fomoSend = (from, to, amount) => {
  const tx = new Transaction().add(createTransferCheckedInstruction(
    getAssociatedTokenAddressSync(USDC_MINT, from.publicKey), USDC_MINT, to, from.publicKey, amount, 6))
  tx.feePayer = fomo.publicKey
  return sendAndConfirmTransaction(conn, tx, [fomo, from], { commitment: 'confirmed' })
}
/** The same send from any other wallet. */
const plainSend = (from, to, amount) => send([createTransferCheckedInstruction(
  getAssociatedTokenAddressSync(USDC_MINT, from.publicKey), USDC_MINT, to, from.publicKey, amount, 6)], [from])

console.log('\n── pump.fun still opens a curve where our shadow curve says it does ──')
{
  /**
   * ⛔⛔ Every presale price, and every market cap shown before launch, assumes the coin will be
   * created at THESE reserves. pump.fun sets them from its own `Global`, which it can change
   * without telling anyone — and the validator clones that account from mainnet, so this reads
   * what is live today. If it ever moves, every quote we gave a buyer was against a curve that no
   * longer exists, and the number to fix is in `curve.mjs`.
   *
   * ⚠ Two of six real coins read from pump.fun's API on 20 Sep sat on curves with different
   * constants, so this is not hypothetical — see `fixtures/pumpfun-market-caps.json`.
   */
  const g = (await conn.getAccountInfo(PublicKey.findProgramAddressSync([Buffer.from('global')], PUMP)[0]))?.data
  ok('pump.fun\'s Global is readable on this chain', !!g)
  if (g) {
    let o = 8 + 1 + 32 + 32
    const u64 = () => { const v = g.readBigUInt64LE(o); o += 8; return v }
    const vt = u64(), vs = u64(), rt = u64()
    ok(`initial virtual token reserves are ours (${VT0})`, vt === VT0, String(vt))
    ok(`initial virtual SOL reserves are ours (${VS0})`, vs === VS0, String(vs))
    ok(`initial real token reserves are ours (${RT0})`, rt === RT0, String(rt))
  }
}

console.log('\n── the shared launch lookup table ──')
let lut
{
  const auth = Keypair.generate(); await fund(auth.publicKey, 2)
  const [create, address] = AddressLookupTableProgram.createLookupTable({
    authority: auth.publicKey, payer: auth.publicKey, recentSlot: await conn.getSlot('finalized') })
  await send([create], [auth])
  // ⚠ In chunks. Thirty-three addresses is over a kilobyte of keys, and one extend carrying them
  // all serialises past the 1,232-byte limit.
  const addrs = launchLookupAddresses(USDC_MINT)
  for (let i = 0; i < addrs.length; i += 15) {
    await send([AddressLookupTableProgram.extendLookupTable({
      payer: auth.publicKey, authority: auth.publicKey, lookupTable: address, addresses: addrs.slice(i, i + 15) })], [auth])
  }
  await sleep(1500)
  lut = (await conn.getAddressLookupTable(address)).value
  ok('table live', !!lut)
}

async function openSale(creator, cfg) {
  const saleId = BigInt(Date.now()) + BigInt(Math.floor(Math.random() * 1e6))
  const depositWallet = Keypair.generate()
  const { sale, vault, depositAccount, tx } = await buildInitializeSaleTx(conn, creator.publicKey, saleId, {
    // ⚠ LAMPORTS, not USDC. The curve is the SOL curve; what buyers send is converted at the
    // swap pool's spot before it ever touches it. A USDC figure here would be a cap of whatever
    // that number of lamports happens to be — about a ten-thousandth of what it looks like.
    launchWindow: 3600, perWalletCap: SOL(20), hardCap: SOL(86),
    protocolFeeBps: 95, creatorFeeBps: 30, creatorFeeRecipient: creator.publicKey,
    name: 'Fomo Coin', symbol: 'FOMOC', uri: 'https://pump.family/demo.json', quote: 'usdc', quoteMint: USDC_MINT,
    ...cfg,
  }, depositWallet)
  // The creator's wallet adds its own signature to bytes that already carry the deposit wallet's.
  tx.partialSign(creator)
  await conn.confirmTransaction(await conn.sendRawTransaction(tx.serialize()), 'confirmed')
  return { sale, vault, depositAccount, saleId }
}

/* ================================================================ opening a sale */

console.log('\n── a creator opens a sale from an ordinary wallet ──')
const creator = Keypair.generate()
await fund(creator.publicKey, 2)
const A = await openSale(creator, { windowSeconds: 60, minRaise: USDC(10) })
{
  const s = decodeSale((await conn.getAccountInfo(A.sale)).data)
  ok('sale opened, in USDC', s.statusLabel === 'Open' && s.quoteLabel === 'usdc')
  ok(`the sale account is exactly SALE_SIZE (${SALE_SIZE}), which the watcher lists sales by`, (await conn.getAccountInfo(A.sale)).data.length === SALE_SIZE)
  ok('no coin address exists yet — it is picked at launch', s.mint.equals(PublicKey.default))
  ok('no dev supply: nothing is sold at open', s.sold === 0n && s.gross === 0n && s.depositors === 0)
  const acct = await getAccount(conn, A.depositAccount)
  ok('the deposit account is owned by the vault, not the deposit wallet', acct.owner.equals(A.vault))
  ok('and the recorded deposit address is an ordinary on-curve wallet', PublicKey.isOnCurve(s.depositWallet.toBytes()))
}

console.log('\n── what opening refuses ──')
{
  const c = Keypair.generate(); await fund(c.publicKey, 2)
  const saleId = 7n
  const sale = saleAddress(c.publicKey, saleId)
  const base = { windowSeconds: 60, launchWindow: 3600, perWalletCap: USDC(400), hardCap: USDC(2000),
    minRaise: USDC(10), protocolFeeBps: 95, creatorFeeBps: 30, creatorFeeRecipient: c.publicKey,
    name: 'X', symbol: 'X', uri: 'https://x', quote: 'usdc', quoteMint: USDC_MINT }

  // The wallet's account exists but was never handed to the vault: its key could drain it.
  const kept = Keypair.generate()
  const own = await getOrCreateAssociatedTokenAccount(conn, c, USDC_MINT, kept.publicKey)
  await refused('a deposit account the vault does not own is refused',
    () => send([initializeSaleIx(c.publicKey, saleId, { ...base, depositWallet: kept.publicKey }).ix], [c]), /BadDepositAccount/)
  ok('(that account really exists, owned by its wallet)', own.owner.equals(kept.publicKey))

  const dw = Keypair.generate()
  await refused('a SOL sale is refused — a FOMO send moves USDC',
    () => send([...depositAccountSetupIxs(c.publicKey, dw.publicKey, vaultAddress(sale)),
                initializeSaleIx(c.publicKey, saleId, { ...base, quote: 'sol', quoteMint: PublicKey.default, depositWallet: dw.publicKey }).ix], [c, dw]),
    /SolSalesDisabled/)
  const fake = await createMint(conn, c, c.publicKey, null, 6)
  const dwf = Keypair.generate()
  await refused('a sale on any mint but the real USDC is refused (the fake-mint theft)',
    () => send([...depositAccountSetupIxs(c.publicKey, dwf.publicKey, vaultAddress(sale), fake),
                initializeSaleIx(c.publicKey, saleId, { ...base, quoteMint: fake, depositWallet: dwf.publicKey }).ix], [c, dwf]),
    /WrongMint/)
  for (const [label, cfg, why] of [
    // ⚠ The floor is an hour on mainnet and 20s in the test build (MIN_LAUNCH_WINDOW), so the
    // suite can run a sale past its deadline. 10 is under both.
    ['a launch deadline under the minimum is refused', { launchWindow: 10 }, /BadLaunchWindow/],
    ['a launch deadline over seven days is refused', { launchWindow: 8 * 86400 }, /BadLaunchWindow/],
    ['a fee reserve far above pump.fun\'s is refused', { protocolFeeBps: 900, creatorFeeBps: 100 }, /FeeRateOutOfRange/],
  ]) {
    const w = Keypair.generate()
    await refused(label, () => send([...depositAccountSetupIxs(c.publicKey, w.publicKey, vaultAddress(sale)),
      initializeSaleIx(c.publicKey, saleId, { ...base, ...cfg, depositWallet: w.publicKey }).ix], [c, w]), why)
  }
}

/* ================================================================ buying */

console.log('\n── buyers send USDC ──')
const alice = await buyer(500)   // FOMO
const bob = await buyer(500)     // FOMO
const phantom = await buyer(500) // not FOMO
const dust = await buyer(500)    // FOMO, below the 2 USDC floor
const before = { alice: await usdcOf(alice.publicKey), phantom: await usdcOf(phantom.publicKey), dust: await usdcOf(dust.publicKey) }

/**
 * ⛔⛔ Every buy here is a FRACTION OF THE LIVE CEILING, never a pinned number of dollars.
 *
 * The 3% ceiling is measured in TOKENS, so what it COSTS in USDC moves with the SOL price — and
 * the swap pool is cloned from mainnet at the start of every run, so that price is whatever the
 * market says today. A figure pinned here goes stale on a market move rather than on a code
 * change: 100 USDC sat comfortably under the ceiling at 143 USDC/SOL on 19 Sep, and on 20 Sep, at
 * 108, the same 100 was over it and the program refused a send the mirror expected to be credited.
 * The suite failed with nothing wrong in the product.
 */
const reserves = await (async () => {
  const v = await pool()
  const [sv, uv] = await conn.getMultipleAccountsInfo([v.solVault, v.usdcVault])
  return [sv.data.readBigUInt64LE(64), uv.data.readBigUInt64LE(64)]
})()
const inSol = (usdc) => solEquivalent(usdc, reserves[0], reserves[1])

/** The most one wallet may spend at the open, in USDC, found against the shadow curve itself. */
const ceilingUsdc = (() => {
  let lo = 0, hi = 10_000
  for (let i = 0; i < 48; i++) {
    const mid = (lo + hi) / 2
    try { new ShadowCurve(VS0).deposit('probe', inSol(USDC(mid))); lo = mid } catch { hi = mid }
  }
  return lo
})()
const share = (f) => USDC(Math.floor(ceilingUsdc * f))
const A1 = share(0.4), B1 = share(0.65), A2 = share(0.9), PHANTOM = share(0.3), DUST = USDC(1)
console.log(`   the 3% ceiling costs ${(ceilingUsdc).toFixed(2)} USDC at the open (SOL at ${(Number(reserves[1]) / 1e6 / (Number(reserves[0]) / 1e9)).toFixed(2)} USDC)`)

await fomoSend(alice, A.depositAccount, A1)
await plainSend(phantom, A.depositAccount, PHANTOM)
await fomoSend(bob, A.depositAccount, B1)
await fomoSend(dust, A.depositAccount, DUST)
await fomoSend(alice, A.depositAccount, A2) // 0.4 + 0.9 of the ceiling: carries alice past 3%
ok('five sends landed in the deposit account',
   (await getAccount(conn, A.depositAccount)).amount === A1 + PHANTOM + B1 + DUST + A2)

console.log('\n── the attester decides each one ──')
const log = (m) => console.log('     ·', m)
const pass1 = await attestSale(conn, attester, A.sale, { fomoCosigner: fomo.publicKey, settleSeconds: 3, log })
{
  /**
   * ⛔ The mirror has to be the SOL curve, and each buy has to be converted at the pool's spot
   * FIRST — the same two steps the program takes. Walking USDC figures onto the SOL curve is the
   * bug this whole design is most exposed to, so the test reproduces the conversion rather than
   * assuming a rate: `inSol` reads the same reserves the credit did.
   */
  const shadow = new ShadowCurve(VS0)
  const aliceOut = shadow.deposit('alice', inSol(A1))
  const bobOut = shadow.deposit('bob', inSol(B1))
  const s = decodeSale((await conn.getAccountInfo(A.sale)).data)
  ok('two FOMO sends credited', pass1.credited.length === 2)
  ok('three sends returned', pass1.returned.length === 3, JSON.stringify(pass1.returned.map((r) => r.why)))
  ok('the Phantom send went back because it was not from FOMO',
     pass1.returned.some((r) => r.owner.equals(phantom.publicKey) && r.why === 'not sent from FOMO'))
  ok('the 1 USDC send went back for the floor', pass1.returned.some((r) => r.owner.equals(dust.publicKey) && r.why === 'DepositBelowMinimum'))
  ok('alice\'s second send went back for the 3% ceiling',
     pass1.returned.some((r) => r.owner.equals(alice.publicKey) && r.why === 'WalletAllocationCapExceeded'))
  ok(`gross is exactly the two credited sends (${Number(A1 + B1) / 1e6} USDC)`, s.gross === A1 + B1, `${s.gross}`)
  ok('and the deposit account holds exactly that', (await getAccount(conn, A.depositAccount)).amount === A1 + B1)
  ok('on-chain sold == the shadow curve, in chain order', s.sold === shadow.sold, `${s.sold} vs ${shadow.sold}`)
  const pa = decodePosition((await conn.getAccountInfo(positionAddress(A.sale, alice.publicKey))).data)
  const pb = decodePosition((await conn.getAccountInfo(positionAddress(A.sale, bob.publicKey))).data)
  ok('alice\'s allocation is exact', pa.allocation === aliceOut && pa.deposited === A1)
  ok('bob\'s allocation is exact', pb.allocation === bobOut && pb.deposited === B1)
  ok('phantom got every unit back', (await usdcOf(phantom.publicKey)) === before.phantom)
  ok('dust got every unit back', (await usdcOf(dust.publicKey)) === before.dust)
  ok('alice was charged only for the send that was credited',
     (await usdcOf(alice.publicKey)) === before.alice - A1)
  ok('nobody got a position they did not earn', !(await conn.getAccountInfo(positionAddress(A.sale, phantom.publicKey))))
}

console.log('\n── dust is ignored, so nobody can drain the attester by spraying it ──')
{
  const sprayer = await buyer(1)
  for (let i = 0; i < 3; i++) await plainSend(sprayer, A.depositAccount, 1n)
  const p = await attestSale(conn, attester, A.sale, { fomoCosigner: fomo.publicKey, settleSeconds: 3 })
  ok('three 0.000001 USDC sends: none returned, none credited', p.ignored === 3 && !p.returned.length && !p.credited.length)
  ok('and gross is unmoved', decodeSale((await conn.getAccountInfo(A.sale)).data).gross === A1 + B1)
}

console.log('\n── a second pass decides nothing twice ──')
{
  const again = await attestSale(conn, attester, A.sale, { fomoCosigner: fomo.publicKey, settleSeconds: 3 })
  ok('no credit and no return repeated', again.credited.length === 0 && again.returned.length === 0)
}

console.log('\n── what the attester cannot do ──')
const POOL_V = await pool()
{
  const [first] = pass1.credited
  const s = decodeSale((await conn.getAccountInfo(A.sale)).data)
  const imposter = Keypair.generate(); await fund(imposter.publicKey, 1)
  const fakeSig = Buffer.alloc(64, 7)
  await refused('anyone but the attester is refused',
    () => send([creditIx(imposter.publicKey, A.sale, A.depositAccount, { sig: fakeSig, ixIndex: 0, slot: first.slot, blockTime: first.blockTime, depositor: imposter.publicKey, amount: USDC(5) }, POOL_V)], [imposter]),
    /NotAttester/)
  await refused('credit money that never arrived',
    () => send([creditIx(attester.publicKey, A.sale, A.depositAccount, { sig: fakeSig, ixIndex: 0, slot: first.slot + 1000, blockTime: first.blockTime, depositor: attester.publicKey, amount: USDC(5) }, POOL_V)], [attester]),
    /CreditExceedsBalance/)
  await refused('credit the same transfer twice',
    () => send([creditIx(attester.publicKey, A.sale, A.depositAccount, { sig: first.sigBytes, ixIndex: first.ixIndex, slot: first.slot, blockTime: first.blockTime, depositor: first.owner, amount: 0n }, POOL_V)], [attester]),
    /already in use/)
  const to = getAssociatedTokenAddressSync(USDC_MINT, attester.publicKey)
  await getOrCreateAssociatedTokenAccount(conn, attester, USDC_MINT, attester.publicKey)
  await refused('take credited deposits out as a "return"',
    () => send([returnTransferIx(attester.publicKey, A.sale, A.vault, A.depositAccount, to, { sig: Buffer.alloc(64, 9), ixIndex: 0, amount: USDC(1) })], [attester]),
    /ReturnTouchesDeposits/)
  ok('the sale is unchanged by all of that', decodeSale((await conn.getAccountInfo(A.sale)).data).gross === s.gross)
}

console.log('\n── the window closes ──')
{
  const s = decodeSale((await conn.getAccountInfo(A.sale)).data)
  await waitUntil(Number(s.windowEnd))
  const late = await buyer(50)
  await fomoSend(late, A.depositAccount, USDC(20))
  await refused('nobody can launch while credits are still open', async () => {
    const msg = new TransactionMessage({
      payerKey: cranker.publicKey, recentBlockhash: (await conn.getLatestBlockhash()).blockhash,
      instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }),
        launchIx(cranker.publicKey, A.sale, A.vault, 1n, s.creatorFeeRecipient)],
    }).compileToV0Message([lut])
    const tx = new VersionedTransaction(msg); tx.sign([cranker])
    await conn.confirmTransaction(await conn.sendTransaction(tx), 'confirmed')
  }, /CreditsStillOpen/)
  await waitUntil(Number(s.windowEnd) + 3)
  const p = await attestSale(conn, attester, A.sale, { fomoCosigner: fomo.publicKey, settleSeconds: 3, log })
  ok('a FOMO send after the window goes back', p.returned.length === 1 && p.returned[0].why === 'sent after the window closed')
  ok('and credits close', p.closed === true)
  ok('late sender whole again', (await usdcOf(late.publicKey)) === USDC(50))
}

/* ================================================================ launch and delivery */

console.log('\n── swap the raise, launch on pump.fun, then deliver ──')
{
  const before = decodeSale((await conn.getAccountInfo(A.sale)).data)
  /**
   * ⚠ Retried, because that is what the service does — every 15 seconds, forever.
   *
   * `positionsOf` now REFUSES a partial read of the deposit history rather than delivering to a
   * subset and reporting success, so a validator that has not caught up raises here instead of
   * silently delivering nothing. One pass is not the contract; converging is.
   */
  const r = await crankUntil(A.sale)
  const s = decodeSale((await conn.getAccountInfo(A.sale)).data)
  A.mint = s.mint
  ok('the raise was swapped before the launch', r.swapped && s.solIn > 0n, `solIn ${s.solIn}`)
  /**
   * ⭐ The whole point of the design, in one assertion. `solExpected` is what buyers were quoted
   * at the pool's spot; `solIn` is what the pool actually paid. The gap is the swap's fee and
   * impact, and it has to be SMALL and on the losing side — more would mean we quoted a rate we
   * could not get.
   */
  const slip = Number(before.solExpected - s.solIn) / Number(before.solExpected)
  ok(`the swap cost ${(slip * 100).toFixed(3)}% against the quoted rate`, slip > 0 && slip < 0.01, String(slip))
  ok('launched', r.launched && s.statusLabel === 'Launched', s.statusLabel)
  ok('the coin is a TOKEN-2022 mint ending in fomo — what `create_v2` makes',
     (await conn.getAccountInfo(A.mint)).owner.equals(TOKEN_2022) && A.mint.toBase58().endsWith('fomo'))
  /**
   * ⭐⭐ The claim the whole rebuild rests on: this is a **SOL-paired** coin, not a WSOL-quoted
   * one. pump.fun recognises the native mint and writes `quote_mint` on the curve as all-zeroes,
   * which is what makes the coin price, graduate and trade exactly like a v1 pump.fun coin.
   *
   * ⛔ If this ever reads WSOL instead of the default pubkey, the coin is a quote-mint coin —
   * every market cap on the site would be denominated wrong and it would not graduate the same
   * way. Read from the curve's own bytes, not from what we passed in.
   */
  {
    const curve = PublicKey.findProgramAddressSync([Buffer.from('bonding-curve'), A.mint.toBuffer()], PUMP)[0]
    const d = (await conn.getAccountInfo(curve)).data
    ok('and its curve is SOL-paired: quote_mint reads all zeroes',
       new PublicKey(d.subarray(83, 115)).equals(PublicKey.default), new PublicKey(d.subarray(83, 115)).toBase58())
    ok('with creator rewards going to the CREATOR, as this sale chose', d[124] === 0, `is_holder_reward=${d[124]}`)
  }
  ok(`tokens received (${s.tokensReceived}) are within a percent of what was sold (${s.sold})`,
     s.tokensReceived > 0n && s.tokensReceived < s.sold && Number(s.sold - s.tokensReceived) / Number(s.sold) < 0.01)
  ok('both buyers were delivered in the same pass', r.delivered === 2)

  const pa = decodePosition((await conn.getAccountInfo(positionAddress(A.sale, alice.publicKey))).data)
  const pb = decodePosition((await conn.getAccountInfo(positionAddress(A.sale, bob.publicKey))).data)
  const owed = (p) => (p.allocation * s.tokensReceived) / s.sold
  ok('alice holds her allocation scaled by what the raise actually bought',
     (await tokensOf(alice.publicKey, A.mint)) === owed(pa), `${await tokensOf(alice.publicKey, A.mint)} vs ${owed(pa)}`)
  ok('bob holds his, scaled by the same factor', (await tokensOf(bob.publicKey, A.mint)) === owed(pb))
  /**
   * ⛔ The fairness claim, stated as a test: the scale is ONE number for everyone. Whatever the
   * swap cost, the ratio between two buyers is exactly the ratio the curve gave them.
   */
  const quoted = Number(pa.allocation) / Number(pb.allocation)
  const paid = Number(await tokensOf(alice.publicKey, A.mint)) / Number(await tokensOf(bob.publicKey, A.mint))
  ok('and the ratio between them is untouched by the swap', Math.abs(quoted / paid - 1) < 1e-6, `${quoted} vs ${paid}`)
  ok('the creator holds none — no dev supply', (await tokensOf(creator.publicKey, A.mint)) === 0n)
  ok('the deposit account holds only the 3 units of ignored dust', (await getAccount(conn, A.depositAccount)).amount === 3n)
  const again = await crankSale(conn, cranker, A.sale, { lookupTable: lut, fomoCosigner: fomo.publicKey })
  ok('delivering again does nothing', again.delivered === 0)
}

console.log('\n── a send after launch still goes back ──')
{
  const after = await buyer(30)
  await fomoSend(after, A.depositAccount, USDC(30))
  const p = await attestSale(conn, attester, A.sale, { fomoCosigner: fomo.publicKey, settleSeconds: 3 })
  ok('returned', p.returned.length === 1 && (await usdcOf(after.publicKey)) === USDC(30))
}

/* ================================================================ failure */

console.log('\n── a launch cannot be pointed at another token program, and cannot be griefed ──')
{
  const c = Keypair.generate(); await fund(c.publicKey, 2)
  const C = await openSale(c, { windowSeconds: 60, minRaise: USDC(10) })
  const dave = await buyer(100)
  await fomoSend(dave, C.depositAccount, USDC(80))
  await attestSale(conn, attester, C.sale, { fomoCosigner: fomo.publicKey, settleSeconds: 3 })
  // The griefer can only target a coin address it knows. Before launch there is none to know.
  ok('before launch the sale holds no coin address a griefer could target',
     decodeSale((await conn.getAccountInfo(C.sale)).data).mint.equals(PublicKey.default))
  // Worst case anyway: grief the address the OLD design would have used (nonce 0).
  const guess = mintAddress(C.sale, 0n)
  const curve = PublicKey.findProgramAddressSync([Buffer.from('bonding-curve'), guess.toBuffer()], PUMP)[0]
  const griefer = Keypair.generate(); await fund(griefer.publicKey, 1)
  // ⛔⛔ The griefable account is the curve's WSOL account, because `create_v2` creates it with a
  // NON-idempotent create. It used to be the curve's USDC account, and moving the quote to WSOL
  // moved the target with it — the hole is the same shape, at a different address.
  await send([createAssociatedTokenAccountIdempotentInstruction(griefer.publicKey, getAssociatedTokenAddressSync(WSOL_MINT, curve, true), curve, WSOL_MINT)], [griefer])
  const s = decodeSale((await conn.getAccountInfo(C.sale)).data)
  await waitUntil(Number(s.windowEnd) + 3)
  await attestSale(conn, attester, C.sale, { fomoCosigner: fomo.publicKey, settleSeconds: 3 })
  await refused('a launch naming a different token program is refused', async () => {
    const ix = launchIx(cranker.publicKey, C.sale, C.vault, 1n, s.creatorFeeRecipient)
    // ⚠ TOKEN_2022, which is the COIN's program. Classic SPL also appears in this instruction now
    // — it is the WSOL side — so swapping that one would be testing a different account.
    ix.keys = ix.keys.map((k) => (k.pubkey.equals(TOKEN_2022) ? { ...k, pubkey: SystemProgram.programId } : k))
    const msg = new TransactionMessage({ payerKey: cranker.publicKey, recentBlockhash: (await conn.getLatestBlockhash()).blockhash,
      instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }), ix] }).compileToV0Message([lut])
    const tx = new VersionedTransaction(msg); tx.sign([cranker])
    await conn.confirmTransaction(await conn.sendTransaction(tx), 'confirmed')
    // ⛔ `InvalidProgramId` (0xbc0): the token program is an `Interface<TokenInterface>`, so
    // Anchor refuses anything that is not a token program before a single byte moves. The v2 path
    // failed this with `WrongTokenAccount` instead — same protection, different layer.
  }, /InvalidProgramId|WrongTokenAccount|ConstraintAddress|0xbc0|0x7dc/)
  const r = await crankUntil(C.sale)
  ok('the sale still launches, at an address nobody could have guessed', r.launched, JSON.stringify(r))
  const launched = decodeSale((await conn.getAccountInfo(C.sale)).data)
  ok(`the coin ends in fomo (${launched.mint.toBase58()})`, launched.mint.toBase58().endsWith('fomo') && !launched.mint.equals(guess))
  ok('and dave is delivered', r.delivered === 1)
}

console.log('\n── a sale that misses its minimum ──')
{
  const c = Keypair.generate(); await fund(c.publicKey, 2)
  const B = await openSale(c, { windowSeconds: 60, minRaise: USDC(1000) })
  // Ceiling-relative for the same reason the buys above are: a pinned 80 is under the 3% ceiling
  // at one SOL price and over it at another, and the sale would then fail for the wrong reason.
  const CAROL = share(0.6)
  const carol = await buyer(Number(CAROL) / 1e6)
  await fomoSend(carol, B.depositAccount, CAROL)
  await attestSale(conn, attester, B.sale, { fomoCosigner: fomo.publicKey, settleSeconds: 3 })
  ok(`carol credited ${Number(CAROL) / 1e6}`, decodeSale((await conn.getAccountInfo(B.sale)).data).gross === CAROL)
  await waitUntil(Number(decodeSale((await conn.getAccountInfo(B.sale)).data).windowEnd) + 3)
  await attestSale(conn, attester, B.sale, { fomoCosigner: fomo.publicKey, settleSeconds: 3 })
  const r = await crankUntil(B.sale)
  const s = decodeSale((await conn.getAccountInfo(B.sale)).data)
  ok('the sale failed', r.failed && s.statusLabel === 'Failed')
  ok('carol was refunded in full, without signing anything', (await usdcOf(carol.publicKey)) === CAROL)
  ok('the deposit account is empty', (await getAccount(conn, B.depositAccount)).amount === 0n)
}

console.log('\n── a window nobody bought into still launches ──')
{
  /**
   * ⭐ The coin is the creator's whole point, so an empty window must not produce nothing. The
   * program skips the buy entirely (no vault token accounts, no transfer, no `buy_v2`) and the
   * coin lands on its curve untouched, at the opening price, for anyone to buy first on pump.fun.
   */
  const c = Keypair.generate(); await fund(c.publicKey, 2)
  const B = await openSale(c, { windowSeconds: 60, minRaise: 0n })
  const before = await conn.getBalance(cranker.publicKey)
  await waitUntil(Number(decodeSale((await conn.getAccountInfo(B.sale)).data).windowEnd) + 3)
  await attestSale(conn, attester, B.sale, { fomoCosigner: fomo.publicKey, settleSeconds: 3 })
  const r = await crankSale(conn, cranker, B.sale, { lookupTable: lut, fomoCosigner: fomo.publicKey, log })
  const s = decodeSale((await conn.getAccountInfo(B.sale)).data)
  ok('it launched with nothing raised', r.launched && s.statusLabel === 'Launched', s.statusLabel)
  ok('the coin exists and ends in fomo', s.mint.toBase58().endsWith('fomo'), s.mint.toBase58())
  ok('nothing was allocated and nothing was received', s.sold === 0n && s.tokensReceived === 0n)

  const curve = decodeBondingCurve((await conn.getAccountInfo(bondingCurveAddress(s.mint))).data)
  ok('its bonding curve opens untouched — the full 79.31% is still for sale',
     curve.realToken === 793_100_000_000_000n, String(curve.realToken))
  ok('at the SOL curve\'s opening reserve (30 SOL), so the first buyer on pump.fun gets the opening price',
     curve.virtualQuote === 30_000_000_000n, String(curve.virtualQuote))
  ok('and it is not complete', curve.complete === false)

  // The vault's token accounts are the ones the buy would have needed. Nobody paid for them.
  const vaultBase = getAssociatedTokenAddressSync(s.mint, B.vault, true, TOKEN_PROGRAM_ID)
  ok('⛔ no vault token account was created, so the cranker paid no rent for an empty one',
     (await conn.getAccountInfo(vaultBase)) === null)
  const spent = (before - (await conn.getBalance(cranker.publicKey))) / 1e9
  ok(`the whole launch cost the cranker ${spent.toFixed(4)} SOL`, spent < 0.01, String(spent))

  // And the creator's floor still works: it is the ONLY thing that can refuse a launch now.
  const d = Keypair.generate(); await fund(d.publicKey, 2)
  const C = await openSale(d, { windowSeconds: 60, minRaise: USDC(10) })
  await waitUntil(Number(decodeSale((await conn.getAccountInfo(C.sale)).data).windowEnd) + 3)
  await attestSale(conn, attester, C.sale, { fomoCosigner: fomo.publicKey, settleSeconds: 3 })
  const r2 = await crankSale(conn, cranker, C.sale, { lookupTable: lut, fomoCosigner: fomo.publicKey, log })
  ok('⛔ but an empty window under a minimum the creator SET still fails instead',
     r2.failed && decodeSale((await conn.getAccountInfo(C.sale)).data).statusLabel === 'Failed')
}

console.log('\n── creator rewards to HOLDERS: the other half of the choice ──')
{
  /**
   * ⭐⭐ The feature the `create_v2` rebuild exists for, proven rather than assumed.
   *
   * ⛔⛔ This is not a flag byte. With holder rewards on, pump.fun makes the curve's creator a
   * `holder-rewards` PDA of the mint, and `creator_vault` is seeded on the CURVE's creator — so
   * the ACCOUNTS in the instruction change too. Build it with the creator's own vault and
   * pump.fun refuses the launch. Everything below fails if `launchIx` forgets that.
   *
   * ⚠ The sale is opened with a real buy in it, not empty: an empty window takes the `no_buys`
   * branch and never touches `buy_exact_sol_in`, so it would prove only that `create_v2`
   * accepted the flag, not that the curve is then buyable.
   */
  const hcreator = Keypair.generate(); await fund(hcreator.publicKey, 2)
  const H = await openSale(hcreator, { windowSeconds: 60, minRaise: 0n, holderRewards: true })
  const hbuyer = await buyer(80)
  await fomoSend(hbuyer, H.depositAccount, USDC(60))
  await attestSale(conn, attester, H.sale, { fomoCosigner: fomo.publicKey, settleSeconds: 3, log })

  const opened = decodeSale((await conn.getAccountInfo(H.sale)).data)
  ok('the sale recorded the choice at open', opened.holderRewards === true)

  await waitUntil(Number(opened.windowEnd) + 3)
  await attestSale(conn, attester, H.sale, { fomoCosigner: fomo.publicKey, settleSeconds: 3, log })
  const r = await crankUntil(H.sale)
  const h = decodeSale((await conn.getAccountInfo(H.sale)).data)
  ok('it launched', r?.launched && h.statusLabel === 'Launched', h.statusLabel)

  const curve = PublicKey.findProgramAddressSync([Buffer.from('bonding-curve'), h.mint.toBuffer()], PUMP)[0]
  const d = (await conn.getAccountInfo(curve)).data
  // ⭐ Read off pump.fun's OWN account, which is the only thing that settles it.
  ok('and pump.fun recorded is_holder_reward = 1 on the curve', d[124] === 1, `is_holder_reward=${d[124]}`)
  ok('still SOL-paired', new PublicKey(d.subarray(83, 115)).equals(PublicKey.default))
  /**
   * ⛔ The curve's creator is the `holder-rewards` PDA, NOT the sale's creator. This is what
   * redirects the fee leg, and it is the field a wrong `creator_vault` would have contradicted.
   */
  const hr = PublicKey.findProgramAddressSync([Buffer.from('holder-rewards'), h.mint.toBuffer()], PUMP)[0]
  ok('the curve\'s creator is the holder-rewards PDA, not the person who opened the sale',
     new PublicKey(d.subarray(49, 81)).equals(hr), new PublicKey(d.subarray(49, 81)).toBase58())

  ok('the buyer was delivered', r.delivered === 1)
  const hp = decodePosition((await conn.getAccountInfo(positionAddress(H.sale, hbuyer.publicKey))).data)
  ok('and holds the allocation scaled by what the raise bought',
     (await tokensOf(hbuyer.publicKey, h.mint)) === (hp.allocation * h.tokensReceived) / h.sold)
  ok('the creator holds none of it either', (await tokensOf(hcreator.publicKey, h.mint)) === 0n)
}

console.log('\n── holder rewards AND nobody bought: still launches ──')
{
  /**
   * ⛔ The intersection of the two rules, which neither section above reaches. An empty window
   * takes the `no_buys` branch and never calls `buy_exact_sol_in`, so the ONLY pump.fun
   * instruction is `create_v2` — carrying a holder-rewards flag with no buy behind it. Both
   * halves are proven separately; a launchpad's promise is that they hold together.
   *
   * ⭐ An empty window launching at all is an operator decision, not a default: the coin exists
   * on its curve at the opening price and anyone can be its first buyer.
   */
  const e = Keypair.generate(); await fund(e.publicKey, 2)
  const E = await openSale(e, { windowSeconds: 60, minRaise: 0n, holderRewards: true })
  await waitUntil(Number(decodeSale((await conn.getAccountInfo(E.sale)).data).windowEnd) + 3)
  await attestSale(conn, attester, E.sale, { fomoCosigner: fomo.publicKey, settleSeconds: 3 })
  const r = await crankUntil(E.sale)
  const s = decodeSale((await conn.getAccountInfo(E.sale)).data)
  ok('it launched with nothing raised and rewards set to holders',
     r.launched && s.statusLabel === 'Launched', s.statusLabel)
  ok('nothing was allocated and nothing was received', s.sold === 0n && s.tokensReceived === 0n)

  const curve = PublicKey.findProgramAddressSync([Buffer.from('bonding-curve'), s.mint.toBuffer()], PUMP)[0]
  const d = (await conn.getAccountInfo(curve)).data
  ok('pump.fun still recorded is_holder_reward = 1', d[124] === 1, `is_holder_reward=${d[124]}`)
  ok('still SOL-paired', new PublicKey(d.subarray(83, 115)).equals(PublicKey.default))
  const hr = PublicKey.findProgramAddressSync([Buffer.from('holder-rewards'), s.mint.toBuffer()], PUMP)[0]
  ok('and the curve\'s creator is the holder-rewards PDA', new PublicKey(d.subarray(49, 81)).equals(hr))
  const c = decodeBondingCurve(d)
  ok('its curve opens untouched — the full 79.31% is still for sale', c.realToken === RT0 && c.complete === false,
     `${c.realToken} vs ${RT0}`)
}

console.log('\n── sale-shaped bytes are not a sale: what every surface checks before showing a deposit address ──')
{
  /**
   * 🔴 An outside review (22 Sep 2026) showed the site accepted ANY account whose bytes decoded as
   * a sale — at any address, written by anyone — and would have shown its deposit account under
   * our name. `isProgramSale` is the answer every page, the indexer and the watcher now ask.
   */
  const info = await conn.getAccountInfo(A.sale)
  ok('the real sale, at its own address, owned by the program, passes', isProgramSale(A.sale, info))
  ok('the same bytes owned by another program do not', !isProgramSale(A.sale, { ...info, owner: TOKEN_2022 }))
  const wrongDisc = Buffer.from(info.data); wrongDisc[0] ^= 1
  ok('the same bytes under another discriminator do not', !isProgramSale(A.sale, { ...info, data: wrongDisc }))
  ok('the same bytes at a different address do not', !isProgramSale(A.vault, info))
  const moved = Buffer.from(info.data); moved.writeBigUInt64LE(decodeSale(info.data).saleId + 1n, 8 + 96)
  ok('bytes naming a different sale id do not derive this address', !isProgramSale(A.sale, { ...info, data: moved }))
  ok('a missing account is not a sale', !isProgramSale(A.sale, null))
}

/** The crank's swap, alone — the raise leaves the deposit account and becomes SOL in the vault. */
const swapOnly = async (sale, vault) => {
  const s = decodeSale((await conn.getAccountInfo(sale)).data)
  const msg = new TransactionMessage({
    payerKey: cranker.publicKey, recentBlockhash: (await conn.getLatestBlockhash()).blockhash,
    instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
      swapToSolIx(cranker.publicKey, sale, vault, await pool(), { ...SWAP_MARKET, depositAccount: s.depositAccount }, s.quoteMint)],
  }).compileToV0Message([lut])
  const tx = new VersionedTransaction(msg); tx.sign([cranker])
  await conn.confirmTransaction(await conn.sendTransaction(tx), 'confirmed')
  return decodeSale((await conn.getAccountInfo(sale)).data)
}
/** A sale through its window with two buyers, credits closed. */
const closedSale = async (cfg, amounts) => {
  const c = Keypair.generate(); await fund(c.publicKey, 2)
  const S = await openSale(c, { windowSeconds: 60, minRaise: 0n, ...cfg })
  const buyers = []
  for (const a of amounts) {
    const w = await buyer(Number(a) / 1e6 + 1)
    await fomoSend(w, S.depositAccount, a)
    buyers.push(w)
  }
  await attestSale(conn, attester, S.sale, { fomoCosigner: fomo.publicKey, settleSeconds: 3 })
  const s = decodeSale((await conn.getAccountInfo(S.sale)).data)
  await waitUntil(Number(s.windowEnd) + 3)
  const p = await attestSale(conn, attester, S.sale, { fomoCosigner: fomo.publicKey, settleSeconds: 3 })
  ok('credits closed on a sale both bought into', p.closed === true && s.gross === amounts.reduce((x, y) => x + y, 0n))
  return { ...S, creator: c, buyers }
}

console.log('\n── swapped at the close, then never launched: the refund comes back in SOL, pro rata ──')
{
  /**
   * 🔴🔴 The hole (outside review, 22 Sep 2026): the swap moves the raise out of the deposit
   * account, and a sale that then misses its launch deadline can be FAILED with the USDC gone.
   * `refund_push` transferred from an empty account and failed for every buyer forever, while the
   * SOL sat behind a `sweep_lamports` that needs `gross == 0`. Nobody could reach it.
   */
  const D1 = share(0.3), D2 = share(0.5)
  const D = await closedSale({ launchWindow: 25 }, [D1, D2])
  const [dave, erin] = D.buyers
  const s1 = await swapOnly(D.sale, D.vault)
  ok('the raise was swapped: SOL in the vault, deposit account empty',
     s1.solIn > 0n && (await getAccount(conn, D.depositAccount)).amount === 0n, `solIn=${s1.solIn}`)
  await waitUntil(Number(s1.launchDeadline))
  await send([failSaleIx(D.sale)], [cranker])
  const s2 = decodeSale((await conn.getAccountInfo(D.sale)).data)
  ok('the sale failed with its USDC already gone', s2.statusLabel === 'Failed' && s2.gross === D1 + D2 && s2.solIn === s1.solIn)
  await refused('the USDC refund is refused on it — it would pay from an empty account',
    () => send([createAssociatedTokenAccountIdempotentInstruction(cranker.publicKey, getAssociatedTokenAddressSync(USDC_MINT, dave.publicKey), dave.publicKey, USDC_MINT),
                refundPushIx(D.sale, D.vault, s2.depositAccount, dave.publicKey, s2.quoteMint)], [cranker]), /SwappedRefund/)
  const before = [await conn.getBalance(dave.publicKey), await conn.getBalance(erin.publicKey)]
  const r = await crankUntil(D.sale)
  ok('the crank refunded both, in SOL, without anyone signing', r.delivered === 2 && r.complete === true)
  const s3 = decodeSale((await conn.getAccountInfo(D.sale)).data)
  const gain = [BigInt(await conn.getBalance(dave.publicKey) - before[0]), BigInt(await conn.getBalance(erin.publicKey) - before[1])]
  // Pro rata on what remains, in deposit order: dave first, erin takes exactly the remainder.
  const daveOwed = D1 * s1.solIn / (D1 + D2)
  ok(`dave got his share of the swap: ${gain[0]} lamports`, gain[0] === daveOwed, `expected ${daveOwed}`)
  ok(`erin got exactly the rest: ${gain[1]} lamports`, gain[1] === s1.solIn - daveOwed, `expected ${s1.solIn - daveOwed}`)
  ok('every lamport of the swap went back and the ledger closed', s3.solIn === 0n && s3.gross === 0n)
  const settled = []
  for (const w of [dave, erin]) settled.push(decodePosition((await conn.getAccountInfo(positionAddress(D.sale, w.publicKey))).data).claimed)
  ok('both positions are settled', settled.every(Boolean))
  // Once every lamport is out, `sol_in` is 0 and the program refuses even earlier, as NotSwapped.
  await refused('a second SOL refund is refused', () => send([refundSolIx(D.sale, D.vault, dave.publicKey)], [cranker]), /AlreadyClaimed|NotSwapped/)
  const vaultBefore = await conn.getBalance(D.vault)
  await send([sweepLamportsIx(D.creator.publicKey, D.sale, D.vault)], [D.creator])
  ok('and the creator can sweep the launch reserve now that nothing is owed', (await conn.getBalance(D.vault)) < vaultBefore)
}

console.log('\n── a position owner who signs their own claim gets exactly what distribute would pay ──')
{
  /**
   * 🔴 `claim_quote` paid the raw quoted allocation while `distribute` pays it scaled by what the
   * raise actually bought (outside review, 22 Sep 2026). The first route always paid MORE, so a
   * signing claimant took from the last positions the crank would deliver.
   */
  const E1 = share(0.3), E2 = share(0.3)
  const E = await closedSale({}, [E1, E2])
  const [fay, gus] = E.buyers
  await fund(gus.publicKey, 0.05)
  const s1 = await swapOnly(E.sale, E.vault)
  const { nonce } = await grind(E.sale.toBase58())
  const msg = new TransactionMessage({
    payerKey: cranker.publicKey, recentBlockhash: (await conn.getLatestBlockhash()).blockhash,
    instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }),
      launchIx(cranker.publicKey, E.sale, E.vault, nonce, s1.creatorFeeRecipient, s1.holderRewards)],
  }).compileToV0Message([lut])
  const tx = new VersionedTransaction(msg); tx.sign([cranker])
  await conn.confirmTransaction(await conn.sendTransaction(tx), 'confirmed')
  const s2 = decodeSale((await conn.getAccountInfo(E.sale)).data)
  ok('launched, nothing delivered yet', s2.statusLabel === 'Launched' && s2.claimedTotal === 0n)
  const claimTx = await buildClaimQuoteTx(conn, gus.publicKey, E.sale, E.vault, s2.mint)
  await sendAndConfirmTransaction(conn, claimTx, [gus], { commitment: 'confirmed' })
  const r = await crankUntil(E.sale)
  ok('the crank delivered the other position', r.delivered === 1 && r.complete === true)
  const owed = async (w) => {
    const p = decodePosition((await conn.getAccountInfo(positionAddress(E.sale, w.publicKey))).data)
    return (p.allocation * s2.tokensReceived) / s2.sold
  }
  ok('gus, who signed, holds his allocation scaled by what the raise bought', (await tokensOf(gus.publicKey, s2.mint)) === (await owed(gus)))
  ok('fay, delivered by the crank, holds hers by the same factor', (await tokensOf(fay.publicKey, s2.mint)) === (await owed(fay)))
  ok('the two paid the same rate, base unit for base unit',
     (await tokensOf(gus.publicKey, s2.mint)) * (await owed(fay)) === (await tokensOf(fay.publicKey, s2.mint)) * (await owed(gus)))
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
