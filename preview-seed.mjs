/**
 * A seeded copy of the API, for looking at the site in states the real chain has never been in.
 *
 *   node preview-seed.mjs [port]        # default 5401
 *
 * ## ⛔ Why this is not the real indexer pointed at mainnet
 *
 * The launchpad has had one real sale, which failed. Every other phase a visitor can land on — a
 * window with hours left, one closing in seconds, a coin waiting to be launched, one on its curve,
 * one that has graduated — has never existed on chain and cannot be conjured there. So this serves
 * the REAL `serve()` and the REAL `view()`/`phaseOf()` off a store filled by hand: what comes back
 * is shaped by the shipped code, and only the rows are invented.
 *
 * ⛔ It never refreshes from a chain, deliberately. The live indexer would mark every one of these
 * addresses missing (they do not exist) and they would drop out of the listing while being looked
 * at. Nothing here writes anywhere but a temporary database.
 *
 * ⚠ The clock is fixed when this starts, so a window seeded with nine minutes left really does
 * run out while you look at it — which is the point, but it means a long review needs a restart
 * to put the open sales back. Restarting re-seeds from the current time and costs nothing.
 *
 * ⚠ The market caps are in SOL, as the real rows are, and get converted to dollars by the page
 * using `solUsd` — so the figures on screen go through exactly the arithmetic the live site uses.
 */
import { PublicKey } from '@solana/web3.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openStore } from './indexer/store.mjs'
import { serve } from './indexer/server.mjs'

const PORT = Number(process.argv[2] ?? 5401)
const now = Math.floor(Date.now() / 1000)
const USDC = (n) => Math.round(n * 1e6)
const SOL_USD = 112

/**
 * Real coin images.
 *
 * ⛔⛔ Chosen by MD5, not by status. Three of these were once picked because they answered 200
 * with `image/webp` — and all three were the same 1,014-byte blank, because that CDN serves one
 * placeholder for every id. A status check cannot see filler. Each of these is over 4KB and
 * hashes differently from the others.
 *
 * ⚠ And all under 350KB. Two of them were multi-megabyte PNGs, so the cards sat blank for several
 * seconds on a fresh load — which looks exactly like a missing image, and was reported as one.
 */
const IMG = [
  'https://axiomtrading-v2.axiom-cdn.io/E6N1Cypj1yFn5qi4C9VVniZkFvrY7xsWGPQ5V4xepump.webp',
  'https://pump.mypinata.cloud/ipfs/bafkreiaccdko2ncppu77h52p6ymjqazvggsurvnh6dlhwknkhutwpli7mi',
  'https://pump.mypinata.cloud/ipfs/bafkreiefpvero4f34cpw6l43zwczl2nvouqp742ecvnblynzpunkpfbm4a',
  'https://pbs.twimg.com/media/HSsiNT4XcAA0Pnj.jpg',
  'https://axiomtrading-v2.axiom-cdn.io/7ddi6TRxtTDjWVD2LV5f2A5Qs9GxGv3LLxdPqXsnm8nn.webp',
  'https://pump.mypinata.cloud/ipfs/bafkreibplonew4wmkgvpyovu55twfgdmmpgoho277g3kivs2etkzir5cmi',
]

/**
 * A deterministic, VALID Solana address.
 *
 * ⛔⛔ Built from 32 real bytes and encoded by `PublicKey`, not by emitting 44 random base58
 * characters. A base58 string of the right LENGTH usually decodes to 33 bytes, not 32, so
 * `new PublicKey(...)` throws — and every seeded coin's page answered "Invalid public key input"
 * while the listing that linked to it looked perfect.
 */
const addr = (seed) => {
  const b = Buffer.alloc(32)
  let x = seed * 2654435761 % 0x7fffffff
  for (let i = 0; i < 32; i++) { x = (x * 1103515245 + 12345) & 0x7fffffff; b[i] = x & 0xff }
  // ⚠ A leading zero byte becomes a leading '1' in base58, so a key starting with several of them
  // renders as `11111111…` — valid, and instantly recognisable as not a real address.
  if (b[0] < 16) b[0] += 16
  return new PublicKey(b).toBase58()
}

/* ── the cast ────────────────────────────────────────────────────────────────────────────────
 * status: 0 open · 1 launched · 2 failed. `phaseOf` derives the rest from the clock, so the
 * window and deadline are what actually decide what each row reads as. */
const SALES = [
  { n: 'Midnight Cat',   t: 'MEOW',  img: IMG[0], status: 0, endsIn: 4 * 3600, gross: 1840.22, sold: 18_400_000_000_000n, dep: 23, cap: 61.4,  state: null },
  { n: 'Closing Soon',   t: 'SOON',  img: IMG[1], status: 0, endsIn: 9 * 60,      gross: 9120.40, sold: 91_200_000_000_000n, dep: 118, cap: 302.8, state: null },
  { n: 'Just Opened',    t: 'FRESH', img: IMG[2], status: 0, endsIn: 86_000,   gross: 12.00,   sold: 120_000_000_000n,    dep: 2,  cap: 30.1,  state: null },
  // Window shut, not yet cranked — the phase a depositor sees for a minute or two.
  { n: 'Waiting To Go',  t: 'WAIT',  img: IMG[3], status: 0, endsIn: -400,     gross: 2450.00, sold: 24_500_000_000_000n, dep: 41, cap: 88.6,  state: null },
  { n: 'On The Curve',   t: 'CURVE', img: IMG[4], status: 1, endsIn: -7200,    gross: 4210.55, sold: 42_100_000_000_000n, dep: 64, cap: 147.9, state: 'curve' },
  { n: 'Graduated Coin', t: 'GRAD',  img: IMG[5], status: 1, endsIn: -260_000, gross: 18_400,  sold: 184_000_000_000_000n, dep: 402, cap: 13_814.9, state: 'migrated' },
  // ⛔ A failed sale reads `refunded`, and its cap is null: the coin was never created.
  { n: 'Missed Minimum', t: 'MISS',  img: IMG[0], status: 2, endsIn: -9000,    gross: 0,       sold: 0n,                  dep: 3,  cap: null,  state: null },
]

const dir = mkdtempSync(join(tmpdir(), 'pf-preview-'))
const store = openStore(join(dir, 'preview.db'))
const pk = (s) => ({ toBase58: () => s })

SALES.forEach((s, i) => {
  const a = addr(i + 7)
  store.add(a, now)
  store.put(a, {
    mint: pk(s.status === 0 ? '11111111111111111111111111111111' : addr(i + 500)),
    name: s.n, symbol: s.t, uri: 'https://example.invalid/m.json',
    authority: pk(addr(i + 900)), creatorFeeRecipient: pk(addr(i + 900)),
    status: s.status,
    windowEnd: BigInt(now + s.endsIn),
    // ⚠ An hour after the window, as the program requires. A row past its deadline reads
    // `expired`, which is a different thing again.
    launchDeadline: BigInt(now + s.endsIn + 3600),
    hardCap: 0n, minRaise: s.status === 2 ? BigInt(USDC(5000)) : 0n, perWalletCap: 0n,
    // ⛔ `quoteLabel`, not `quote`. The store writes `s.quoteLabel ?? 'sol'`, and a row stored as
    // a SOL sale fails `isGenuineSale` and is filtered out of every listing — silently, because
    // that filter exists to hide sales priced in a fake USDC, which is exactly what this looked
    // like. The rows were seeded, served and dropped, and the page simply showed nothing.
    quoteLabel: 'usdc', quoteMint: pk('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'),
    gross: BigInt(USDC(s.gross)), sold: s.sold, depositors: s.dep,
    /**
     * ⛔ The SOL side, seeded too — leaving it out is what made the preview lie.
     *
     * The real program accumulates `sol_expected` on EVERY credit, so a live sale can never show
     * a raise of zero next to tokens sold. Seeding `gross` alone produced exactly that impossible
     * row, which read as a display bug and hid a real one underneath it.
     *
     * `solIn` only exists once the swap at the close has run, so it is set for launched sales and
     * left at zero while the window is still open — the same way the chain has it.
     */
    solExpected: BigInt(Math.round((s.gross / SOL_USD) * 1e9)),
    solIn: s.status === 1 ? BigInt(Math.round((s.gross / SOL_USD) * 0.9975 * 1e9)) : 0n,
    holderRewards: i % 2 === 0,
  }, now)
  store.putMetadata(a, { image: s.img, description: `${s.n} — a Pump Family launch.` }, 'ok', null)
  store.putMarket(a, { state: s.state, cap: s.cap, pool: s.state === 'migrated' ? addr(i + 300) : null })
})

/**
 * ⛔ A stub, not an `Indexer`. It has no connection and no timers, so nothing it serves can be
 * overwritten by a refresh against a chain these addresses are not on.
 */
const stub = {
  store,
  opts: { rpc: 'seeded://preview' },
  chainTime: now,
  solUsd: SOL_USD,
  // Our own token, priced as the real one will be. `FAMILY_MINT` must be set for it to appear.
  family: { mint: (process.env.FAMILY_MINT ?? '').trim(), state: 'curve', cap: 30.6, pool: null },
  stats: { discovered: SALES.length, refreshed: SALES.length, metadata: SALES.length,
           deposits: 0, backfills: 1, errors: 0, lastError: null, since: Date.now() },
}

await serve(stub, PORT)
console.log(`seeded ${SALES.length} sales + ${process.env.FAMILY_MINT ? 'the FAMILY token' : 'no family token'} on :${PORT}`)
console.log('phases:', SALES.map((s) => s.t).join(' '))
