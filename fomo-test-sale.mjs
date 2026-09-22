/**
 * Opens ONE mainnet sale for the real-FOMO-send test, and nothing else.
 *
 * ## ⛔ Why this exists rather than the launch form
 *
 * The form pins `minRaise` to 0 (the operator's call: "a launch is never conditional on other
 * people turning up"). On mainnet that makes every sale it opens **unconditional** — at the close
 * the watcher launches a real coin on pump.fun with whatever was raised, and a pump.fun launch can
 * never be undone. A $3 test opened through the form would leave a permanent junk coin on the
 * mainnet curve, bought by a stranger for all we know.
 *
 * The PROGRAM still honours a minimum raise; only the form stopped offering one. So the test sale
 * is opened here with a minimum far above the test amount: the send is credited (which is the only
 * thing the test is asking about), the window closes below the minimum, and the watcher fails the
 * sale and pushes the refund back. No coin is ever created.
 *
 * ⚠ It is otherwise the SAME path the site uses — same builder, same live fee legs, same capacity
 * derivation — so what it proves about crediting carries over to a real sale.
 *
 * Usage:
 *   node fomo-test-sale.mjs --rpc <mainnet>              # what it would do, signs nothing
 *   node fomo-test-sale.mjs --rpc <mainnet> --yes        # open it
 *   node fomo-test-sale.mjs --rpc <mainnet> --status <sale address>
 */
import { Connection, Keypair, PublicKey } from '@solana/web3.js'
import { readFileSync } from 'node:fs'
import { buildInitializeSaleTx, decodeSale, USDC_MINT } from './program.mjs'
import { readFeeSchedule, feesAtMarketCap } from './fees.mjs'
import { solCost, totalWithFees, RT0, VS0, VT0 } from './curve.mjs'

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`)
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d
}
const RPC = arg('rpc', process.env.SOLANA_RPC_URL)
const YES = process.argv.includes('--yes')
const WINDOW_SECONDS = Number(arg('window', 900))       // 15 minutes
const LAUNCH_WINDOW = Number(arg('launch-window', 3600))
// ⚠ High on purpose. The sale is PUBLIC — it shows up on Explore like any other, and a stranger
// sending through FOMO would count towards this minimum. A figure nobody will reach by accident is
// what keeps a test sale from launching a real coin on somebody else's money.
const MIN_RAISE_USDC = Number(arg('min-raise', 5000))
const CREATOR_KEY = arg('creator', 'keys/deployer-mainnet.json')

if (!RPC) { console.error('Pass --rpc <url> (or set SOLANA_RPC_URL).'); process.exit(1) }
const conn = new Connection(RPC, 'confirmed')
const creator = Keypair.fromSecretKey(new Uint8Array(JSON.parse(readFileSync(CREATOR_KEY, 'utf8'))))

const status = arg('status')
if (status) {
  const acc = await conn.getAccountInfo(new PublicKey(status))
  if (!acc) { console.error(`no sale at ${status}`); process.exit(1) }
  const s = decodeSale(acc.data)
  const PHASE = ['open', 'launched', 'failed', 'refunded']
  console.log(`
  sale        ${status}
  status      ${PHASE[s.status] ?? s.status}
  raised      ${(Number(s.gross) / 1e6).toFixed(2)} USDC   (minimum ${(Number(s.minRaise) / 1e6).toFixed(2)})
  window ends ${new Date(Number(s.windowEnd) * 1000).toISOString()}
  deadline    ${new Date(Number(s.launchDeadline) * 1000).toISOString()}
  mint        ${s.mint?.toBase58?.() ?? '—'}
`)
  process.exit(0)
}

// The same figures the form computes, read live rather than assumed.
const fees = feesAtMarketCap(await readFeeSchedule(conn), 27_960_000_000n)
const capacity = totalWithFees(solCost(RT0, VS0, VT0), fees.protocolBps, fees.creatorBps) - 1n
const balance = await conn.getBalance(creator.publicKey)

console.log(`
  rpc          ${RPC}
  creator      ${creator.publicKey.toBase58()}  (${(balance / 1e9).toFixed(4)} SOL)
  window       ${WINDOW_SECONDS / 60} min, launch deadline ${LAUNCH_WINDOW / 3600}h after it
  minimum      ${MIN_RAISE_USDC} USDC  ⭐ a $3 send misses this, so the sale FAILS and refunds
  capacity     ${(Number(capacity) / 1e9).toFixed(2)} SOL
  fee legs     protocol ${fees.protocolBps} bps, creator ${fees.creatorBps} bps
`)

if (!YES) { console.log('  Nothing signed. Re-run with --yes to open it.\n'); process.exit(0) }

const saleId = BigInt(Date.now())
const depositWallet = Keypair.generate()
const { sale, depositAccount, tx } = await buildInitializeSaleTx(conn, creator.publicKey, saleId, {
  windowSeconds: WINDOW_SECONDS,
  launchWindow: LAUNCH_WINDOW,
  perWalletCap: capacity,
  hardCap: capacity,
  minRaise: BigInt(Math.round(MIN_RAISE_USDC * 1e6)),
  protocolFeeBps: Number(fees.protocolBps),
  creatorFeeBps: Number(fees.creatorBps),
  creatorFeeRecipient: creator.publicKey,
  name: 'FOMO send test',
  symbol: 'FOMOTEST',
  uri: 'https://pump.family/demo.json',
  quote: 'usdc',
  quoteMint: USDC_MINT,
}, depositWallet)
tx.partialSign(creator)
const sig = await conn.sendRawTransaction(tx.serialize())
await conn.confirmTransaction(sig, 'confirmed')

const s = decodeSale((await conn.getAccountInfo(sale)).data)
console.log(`
✅ open.

  sale             ${sale.toBase58()}
  ⭐ SEND USDC TO  ${depositWallet.publicKey.toBase58()}
     (its USDC token account, ${depositAccount.toBase58()}, is what actually holds the money —
      ⛔ do NOT paste that one: a sender resolves an OWNER address to its token account, which is
      why the deposit wallet is an ordinary on-curve address and is what the site hands out.)
  window closes    ${new Date(Number(s.windowEnd) * 1000).toISOString()}  (${new Date(Number(s.windowEnd) * 1000).toLocaleTimeString()})
  page             https://pump.family/sale/${sale.toBase58()}
  signature        ${sig}

Send about 3 USDC from FOMO (cash → Withdraw → Solana · USDC) to the deposit address above.
Watch it with:

  node fomo-test-sale.mjs --rpc <rpc> --status ${sale.toBase58()}

⚠ The minimum is ${MIN_RAISE_USDC} USDC, so after the window the watcher fails the sale and pushes
the refund back to the sender. No coin is created.
`)
