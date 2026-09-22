# Pump Family — a pump.fun launchpad whose first buys happen on FOMO

**Live on Solana mainnet.** Program `8WkibpqR4jnkxpv8nHk9t3Rgw9L4UqECYYwiAGYnu8Hf`, site
**https://pump.family**. This file is what the thing *is*.

**$FAMILY** — the platform's own coin — is `FvMLDEUDKUr9C34e8Nynz5Aqfdk34a2RBKQxygLpfomo`.

⚠ It did **not** come through a window. $FAMILY was launched directly on pump.fun and has since
graduated to an AMM pool; this program never touched it. It is listed on the site as the project's
own token, marked `featured`, and is deliberately the one coin there that is not the output of the
mechanism this repo describes.

A creator opens a **window** and chooses how long it lasts. During the window the coin can only be
bought by **sending USDC from the FOMO app** (fomo.family) to the sale's deposit address. When the
window closes the raise is swapped to SOL, the coin is created on pump.fun's **regular SOL bonding
curve** and bought in one atomic transaction, the tokens are pushed to every buyer, and it trades
freely. The creator gets no tokens of their own: **there is no dev buy.**

⭐ **Two assets, on purpose.** Buyers pay USDC because that is what FOMO sends; the coin pairs with
SOL because that is what a regular pump.fun coin is. The vault holds USDC for the whole window — so
a sale that fails refunds exactly what was sent — and swaps once, at the close, through a pool the
program pins (Raydium AMM v4, measured at **0.25–0.32% all-in**).

⛔ Because the raise buys the curve with however much SOL that swap returned, a buyer's final token
count is settled **at launch**: every allocation is scaled by `tokens_received / sold`, **one factor
for the first buyer and the last**. Relative shares are exactly what the curve promised; only the
absolute count moves.

Every figure below was measured — against the live mainnet programs, or by running the code in this
repo — not estimated. Where a number is stale it is the fault of this file, not of the note.

---

## Why the buy is a SEND, and not a call into this program

FOMO co-signs every transaction its app makes, with `AgmLJBMDCqWynYnQiPCuj9ewsNNsBJXyzoUhD9LJzN51`,
sends to outside addresses included. Nobody else can produce that signature, so it is the one
unforgeable marker that money came out of FOMO.

⛔ **There is no FOMO partnership and none is needed.** FOMO's backend will never build a call into
a stranger's program, but it will sign a plain USDC transfer to any address. So the buy is a plain
transfer, and this program reads it after the fact.

A Solana program cannot see the signers of an *earlier* transaction. That gap is what the
**attester** fills: a watcher we run reads every transfer into a sale's deposit account and either
**credits** it (FOMO co-signed, inside the window, inside the caps) or **returns** it to the sender.

### What the attester can and cannot do — the trust boundary

It is trusted for **attribution only**, and the program bounds it in four directions:

| it cannot | because |
|---|---|
| credit money that never arrived | `CreditExceedsBalance` — the deposit account's own balance is checked |
| credit a transfer twice, or both credit and return it | the receipt PDA, seeded by the transfer's signature |
| reorder credits across slots | `SlotOutOfOrder` — `slot` must not go backwards |
| return money that was credited | `ReturnTouchesDeposits` — a return can only move what is not a deposit |

Every credit emits the transfer's signature, so anyone can check an attribution against the chain.

⛔ **What a stolen attester key could do** is misattribute a credit, and send uncredited money to
the wrong place. It cannot take credited funds. That is the residual risk, stated rather than
explained away.

⚠ A dead attester stalls a sale for at most `CREDIT_GRACE` — **15 minutes** past the window, after
which anyone may launch or fail the sale without it.

### The upgrade authority — the other trust fact

The program is upgradeable, and the upgrade authority is a single wallet,
`B5uT8edsagZApqRkj1p6iKJAsVGMScvMjjaxR3U6z9un`, with no multisig and no timelock. Whoever holds
that key can replace the program, custody rules included. That is a fact about this deployment,
not a property of the design; moving the authority to a multisig is the operator's decision and has
not been made. The deployed bytes can be compared to this source with `./verify-program.sh`.

### What it does not protect against

- **One person, several wallets.** The 3% per-wallet cap is per FOMO wallet. Nothing stops a
  buyer entering from five of them.
- **The cap is measured before the close.** Each wallet's cap is checked on what it sends, priced
  at the pool's spot when it arrives. The swap at the close then scales every position by one
  factor, so a wallet's share of the coin is exactly its share of the raise — but the absolute
  count it ends up with is not known until the close.
- **Attribution is centralised.** See above. The program verifies the money; the attester says
  whose it is.

---

## The lifecycle

| phase | what happens | instruction |
|---|---|---|
| open a sale | any Solana wallet. Name/ticker/logo, window length (1 min – 30 days), how long after it closes the launch may still happen (1h – 7d), hard cap, per-wallet cap, min raise, creator rewards to **you** or to **holders**. No coin address yet | `initialize_sale` |
| the window | buyers send USDC from FOMO to the sale's deposit address | — |
| | the attester books each transfer at the shadow curve's price for its place in line | `credit` |
| | or sends it back: not FOMO, too late, or over a cap | `return_transfer` |
| window closes | the attester says everything that arrived has been decided (else a 15 min grace) | `close_credits` |
| swap | the whole raise becomes SOL, once, through the pinned pool | `swap_to_sol` |
| launch | `create` + `buy` in **one** transaction, mint picked here. ⭐ With **no buys at all** the buy is skipped and the coin still launches | `launch` |
| deliver | tokens pushed to every buyer's own token account. **Nobody signs a claim** | `distribute` |
| or fail | min raise missed, or nobody launched before the deadline | `fail_sale` → `refund_push` |
| after | the creator reclaims whatever of the launch reserve went unspent | `sweep_lamports` |

The site's phases are the ones a buyer sees: open / launching / refunding / launched / refunded.

⭐ **Delivery is a push, not a claim**, and that is forced by the design: a FOMO user does not
control the Solana wallet the money came from in any way they can sign with. So the cranker pays
for the buyer's token account and sends the tokens to them. `distribute` and `refund_push` are both
permissionless.

### Each sale gets its own deposit address

A throwaway on-curve keypair, whose USDC associated account is handed to the sale's vault PDA
(`SetAuthority AccountOwner`) in the same transaction that opens the sale. The keypair is then
irrelevant — the vault owns the money.

⚠ **Some wallets prepend `createIdempotent(recipient ATA)` to a send, and our deposit accounts
refuse it** (the owner is a PDA, not the recipient key). FOMO's observed sends are plain transfers.

---

## The shadow curve

A deposit is priced **as if it were a real bonding-curve buy at that moment in the queue**. First
money in gets the cheap tokens; later money walks the price up. At close the vault executes ONE
real buy for the summed token amount, and every buyer's allocation is exactly what the shadow curve
already promised.

This is exact, not an approximation: a constant-product curve composes, so buying with `r1` then
`r2` yields the same tokens as buying once with `r1+r2`. Verified to ~370 base units of floor dust
across 1000 deposits, and the dust stays in the vault.

### The numbers

The curve is pump.fun's SOL curve, so every curve figure is in SOL — while what buyers send, and
what a refund returns, is USDC.

| | |
|---|---|
| buying the whole curve (793,100,000 tokens, all-in) | **86.07 SOL** |
| market cap at the open | 27.96 SOL |
| market cap at graduation | 410.9 SOL |
| smallest buy | **2 USDC** |
| the swap, all-in | 0.251% on 200 USDC · 0.315% on a full raise |

⚠⚠ **Two units, and they are not interchangeable.** `gross` and `deposited` are USDC; every cap,
`sol_expected`, `sol_in` and the whole curve are lamports. Reading one as the other is out by the
SOL price, and it has already printed a 30-SOL curve as 30 billion USDC, drawn a progress bar with
a different currency on each side of the slash, and set caps a thousand times too small in three
separate test files. If a figure here talks about money, check which one it means.

### The fairness gradient

200 equal buys, measured by running `curve.mjs`:

| raise | first buyer | median | last buyer | aggregate |
|---|---|---|---|---|
| 5 SOL | 1.34x | 1.14x | 0.99x | 1.15x |
| 10 SOL | 1.74x | 1.28x | 0.99x | 1.31x |
| 20 SOL | 2.71x | 1.53x | 0.99x | 1.64x |
| 42.5 SOL | 5.65x | 1.96x | 0.99x | 2.37x |
| 86 SOL (full curve) | **14.30x** | 2.47x | 0.99x | 3.78x |

The last buyer always enters within 1% of the open price — that is the property that makes this
defensible. Something has to stop one wallet taking the whole cheap early section; without it the
first transaction in wins 14x at a full raise. Flat pro-rata pricing (everyone gets the average) is
strictly worse: it puts *every* participant at the aggregate with nothing earned by being early.

---

## The two hard rules

**A minimum deposit, per denomination.** 2 USDC, or 0.01 SOL. The binding reason is rent: a
position has to be worth more than the ~0.002 SOL of token-account rent it costs to deliver. The
fee distortion people reach for first is real but two orders of magnitude smaller.

⛔ **`MIN_DEPOSIT` is a lamport constant**, and reading it against a six-decimal quote made the
floor **10 USDC** — a thousand times stricter than intended. `Quote::min_deposit()` is the only
correct source.

**No wallet may end a window holding more than 3% of supply** (30,000,000 tokens). Denominated in
TOKENS, deliberately: a cap in money bounds what a wallet *spends* while leaving what it *receives*
unbounded at exactly the moment that matters — the same money buys several times the tokens at the
open that it buys at the close. ⭐ It is also the only per-wallet limit the launch form sets now:
the per-sale cap is pinned to the curve's whole capacity, so what every buyer meets is this
ceiling, and what it COSTS moves with the curve:

| | at the open | after 10 SOL of queue | after 40 |
|---|---|---|---|
| SOL needed to reach 3% of supply | **0.874** | 1.558 | 4.874 |

This is a protocol ceiling a creator cannot loosen, only tighten. Consequences:

- **A full-capacity raise needs at least 27 wallets.** 26 wallets buying exactly to the ceiling
  reach 780,000,000 of the curve's 793,100,000 tokens — measured by running the curve, not argued.
- ⛔ **It is not one wallet per person, and on chain it cannot be.** `buy` has no notion of identity
  and neither does this program. Three wallets take 8.99% between them — asserted in
  `curve.test.mjs` so the limit is on the record rather than discovered later. The ceiling raises
  the cost of splitting; only an identity layer above the chain removes it.

---

## ⛔ What cannot be done, and why the window works at all

`buy` on a pump.fun curve **cannot be gated**. Its only signer is the buyer; `BondingCurve` carries
no start time, no trading-enabled flag and no permitted-buyer field, and none of the program's
instructions pauses a single launch.

The window works for one reason only: **the mint does not exist during it.** Any design where the
coin is already live on pump.fun during a "restricted" window is theatre — the IDL is on chain and
bots watch `CreateEvent`.

And `create` + `buy` **fit in ONE transaction** (924 bytes through this program's CPI against a
1,232 limit, with the lookup table). So the coin cannot exist at the opening price without this
program's buy landing in the same transaction. Nothing can snipe the gap, because there is no gap.

⭐ **A window nobody bought into still launches.** There is no `sold > 0` condition: the coin is
the creator's whole point, and making it conditional on strangers turning up means an empty window
produces nothing at all. With nothing sold the program skips the vault token accounts, the transfer
and `buy_v2` entirely — the coin lands on its curve untouched, at the opening price, and the first
buyer on pump.fun gets exactly that. **The minimum raise is the only floor**, it is the creator's
own dial, and it defaults to zero.

⚠ Deposits are **final**. The shadow curve prices each one against the state the previous one left,
so unwinding one mid-window would silently re-price everyone behind it. Money comes back only if
the sale fails.

---

## The launch transaction

Two transactions, both permissionless and both cranked by the watcher: `swap_to_sol`, then
`create` + `buy`. They are **not atomic together**, on purpose — what protects the money is the
program's own minimum-out and its before/after balance check, not the two landing in one slot. A
swap that lands alone just leaves SOL in the vault for the next pass to launch.

⭐ **pump.fun's `create_v2` path, quoted in WSOL**, which means a **Token-2022 mint** on a
**SOL-paired** curve. pump.fun recognises the native mint and writes `quote_mint` on the curve as
all-zeroes, so the coin prices, graduates and trades exactly like any other SOL pump.fun coin. The
buy is `buy_exact_sol_in` — the launch spends what the swap actually returned, so lamports are the
known quantity rather than a token count.

⛔⛔ This was **v1 `create` until 21 Sep 2026**, on the reasoning that "`Global`'s
`whitelisted_quote_mints` holds USDC and nothing else, so WSOL is not a quote mint and `create_v2`
cannot make a SOL-paired coin". The whitelist reading was correct — it still holds USDC alone —
and the conclusion was wrong: WSOL never consults that list. Measured 21 Sep 2026: of the **70
newest coins on pump.fun, all 70** are `create_v2` and 62 are SOL-paired this way, while v1
`create` is used by none of them. Pinned by mainnet coin `7mCnMuMpv…pump`.

⚠ Both transactions need the **shared lookup table** — 33 fixed addresses, the launch's constants
plus the swap venue's. ⛔⛔ One `extendLookupTable` carrying all of them is 1,242 bytes against a
1,232 limit, so the tool that builds it chunks.

⛔⛔ **The mint is picked AT LAUNCH**, from a random `u64` nonce, so nobody can know the coin's
address early enough to grief the accounts `create` needs. A pre-announced address is a permanent
griefing target; a nonce chosen in the launch transaction is not.

**Every mint ends in `fomo`**, enforced on chain — by grinding a *seed*, never a keypair, because
the mint is a PDA precisely so that launching needs no secret and anyone can trigger it. A ground
keypair would put a signature back in the path and hand the creator a hostage over buyers' money.

⭐ The on-chain check does not base58-encode the key. Base58 emits digits least significant first,
so the trailing characters are the first remainders of repeated division by 58 — four divmod passes
over 32 bytes rather than a 44-character encode. When grinding, test the **last** character first:
one divmod pass rejects 57 candidates in 58, which is ~15 seconds of work instead of ten minutes.

**Creator rewards go to the creator OR to the coin's holders**, chosen on the launch form and
recorded on the sale at open. It is pump.fun's `is_holder_reward`, an argument of `create_v2`.

⛔⛔ **It is not a flag byte — it moves accounts.** With holder rewards on, pump.fun makes the
curve's creator a `holder-rewards` PDA of the mint, and `creator_vault` is seeded on the CURVE's
creator. A launch built with the creator's own vault is refused. `launchIx` derives both from the
sale's stored choice; the lifecycle suite launches one of each and reads the flag back off
pump.fun's own curve account.

⛔ Permanent from the moment the window closes. `update_holder_reward_config` sets pump.fun's
GLOBAL switch and needs their authority, and a per-coin `SharingConfig` can only be created by
them, so there is no repair. See `PUMPFUN-OPTIONS.md`.

---

## ⛔⛔ Token metadata is PERMANENT

A Pump Family coin is launched with `create_v2`, so it is a **Token-2022** mint carrying its
metadata in the mint's own extension — and that metadata has **no update authority at all**.
Nobody can repair it, including us. Decoded on **18 Sep 2026**:

```
owner                      : TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb   (Token-2022)
MetadataPointer authority  : 11111111111111111111111111111111             (none)
TokenMetadata  authority   : 11111111111111111111111111111111             (none)
mint authority             : none      supply 1,000,000,000.000000, 6 decimals, no freeze authority
```

⭐ **Nobody holds it — not pump.fun, not the creator, not us.** That is stronger than the v1
Metaplex path this build used until 21 Sep 2026, where the account is written `is_mutable = false`
with the update authority held by pump.fun's own `TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM`.
Both freeze; this one freezes with nobody holding a key at all.

Name, symbol and URI are frozen the moment the coin launches and **nobody can repair them**. Pump
Family makes this sharper than an ordinary pump.fun launch, because the sale fixes the URI when the
window OPENS, potentially days before the mint exists. A URI that stops resolving in between leaves
a permanently broken coin that people have already paid for.

`metadata.mjs` therefore validates before anything is frozen: fetches the URI, parses it, checks
`name`/`symbol`/`image` are present and within pump.fun's limits, fetches the image, and warns when
either is not content addressed. `node metadata.mjs <uri>` runs it.

⚠ Logos are uploaded through **our own `/api/ipfs` proxy**, because pump.fun's upload route sends no
CORS headers and a browser cannot call it directly.

---

## 🔴 The fee is 125 bps, and `Global` says otherwise

`Global.creator_fee_basis_points` reads **5**. The real creator fee is **30**. `buy` does not read
that field at all — it CPIs into the fee program's `GetFees`, which returns `(0, 95, 30)`.

Budgeting off `Global` under-funds every launch by 25 bps and the buy reverts:

```
AnchorError: TooMuchSolRequired  (6002)
  Left:  2450000000     <- what we budgeted at 95+5
  Right: 2456064354     <- what the program demanded
```

`cost + ceil(cost×95/10000) + ceil(cost×30/10000)` reproduces `2456064354` to the lamport. Pinned
by the `matches_a_real_rejection` unit test.

⭐ The rate is a **schedule keyed on market cap** that pump.fun can change with `upsert_fee_tiers`,
so it is stored per sale rather than hardcoded: `initialize_sale` takes `protocol_fee_bps` and
`creator_fee_bps` and floors their sum at 125. `node fees.mjs` prints the live schedule, and the
integration suite asserts it against what the program floors at, so a tier change surfaces as a
failing test rather than as a production launch reverting.

⛔ The ceiling is **150 bps**, close on purpose (review, 16 Sep 2026): whatever is reserved above
the real fee is USDC the launch buy does not spend, and nothing can move it out of the vault
afterwards.

⚠ **The fee legs are ceiled separately.** The closed form `gross × 10000 / 10125` under-funds the
vault on roughly half of all deposits, by one unit, which reverts the launch. `split_deposit` walks
the value down until the reconstruction genuinely fits.

---

## The pieces

| | |
|---|---|
| `programs/pumpfamily/src/lib.rs` | the Anchor program. Read its module docs — they are maintained |
| `programs/pumpfamily/src/curve.rs` | the shadow curve on chain, `u128` throughout |
| `programs/pumpfamily/src/pump.rs` | hand-rolled CPI into pump.fun, built from the on-chain IDL |
| `curve.mjs` `program.mjs` `fees.mjs` `metadata.mjs` | shared with the browser — **symlinked** into `web/src`, never copied |
| `market.mjs` | where a LAUNCHED coin's price lives: its bonding curve, or the pool it migrated into |
| `indexer/` | sale discovery and the site's API |
| `watcher/` | the attester and cranker service |
| `web/` | Vite + React. `#create` · `#explore` · `#sale` · `#portfolio` · `#mytokens` · `#how` |

**Nothing is duplicated.** The test suites import the same `program.mjs` the site sends
transactions with, so the encoders in the browser are the encoders proven against real pump.fun
rather than a second copy free to drift.

⚠ `web/src/polyfill.js` must stay the **first import** in `main.jsx`. ES imports are hoisted and
evaluated before any statement in the importing module's body, so assigning `globalThis.Buffer`
inside `main.jsx` runs *after* `@solana/spl-token` has already thrown `Buffer is not defined`, and
the page renders blank.

### Why there is an indexer

The obvious way to list sales is `getProgramAccounts` with a memcmp filter. **Public RPCs refuse
it** — publicnode does, and it was 403 on the operator's old Helius plan — and it is the first
method any provider disables under load, so a listing built on it is one billing tier away from
being empty.

🔴 And the same endpoint **blocks `getMultipleAccounts` above ten accounts** — measured 18 Sep
2026: 10 answers, 15 is `403 Request blocked`. The indexer batched at 100, the protocol limit, so
every refresh would have thrown the moment the launchpad held more than ten sales, freezing the
listing at its last good read with the error visible only in `/api/health`. It batches at
`RPC_BATCH`, default **10**.

`indexer/` avoids it, using two calls nobody blocks: `getSignaturesForAddress(PROGRAM_ID)` to walk
history backwards, and `logsSubscribe` to catch sales opened while it runs. Both yield only an
**address**; every number then comes from `getAccountInfo` on the sale itself. That split is the
point — a replayed event stream drifts from the chain the moment one deposit is missed, whereas an
account read either reflects the chain or it failed. The store is a cache of addresses, not a
ledger.

| route | |
|---|---|
| `GET /api/sales` | every known sale, open first and closing soonest at the top |
| `GET /api/sales?phase=open` | `open` · `awaiting-launch` · `launched` · `failed` · `expired` |
| `GET /api/sales/<address>` | one sale |
| `GET /api/sales/<address>/history` | its deposits, raw — the price chart's data |
| `GET /api/stats` | launches, open now, raised: the numbers in the listing header |
| `GET /api/health` | rows, discovered, errors, uptime, clock skew |
| `POST /api/ipfs` | the logo upload proxy |

### 🔴 A coin is priced by a different account in each phase

Three, and only one of them is right at a time:

| phase | priced from |
|---|---|
| in the window | the shadow curve, off `sold` — no RPC, exact |
| launched | pump.fun's `BondingCurve`, PDA `["bonding-curve", mint]` |
| migrated | the pump AMM pool's two token accounts |

⛔⛔ **A migrated curve reads all zeroes** — `virtual_token 0, virtual_quote 0, real_token 0,
real_quote 0, complete 1`, measured on a real graduated coin and pinned in `market.test.mjs`. So a
listing that prices a coin from its curve shows a live, graduated coin as worth **0**. `complete`
is the marker, and it is sticky.

⭐ **The pool address derives** — `["pool", u16 index, PDA["pool-authority", mint], base, quote]`
under `pAMMBay…` — so a migrated coin needs no `getProgramAccounts` to find its market. The index
is 0 on every migration seen, and the indexer walks a few rather than reading one miss as "no pool".

⛔ When nothing can price a coin the answer is **`null`, never 0**: the listing shows a dash. An
unreadable pool and a worthless coin must not look the same.

⚠ **Phases are judged on the chain's clock, not the host's.** `window_end` is written from Solana's
`Clock::unix_timestamp`, which derives from slot progression and drifts under load — 4,605 seconds
behind wall time on the local validator while these tests ran. Comparing against `Date.now()` reads
open sales as closed, so `/api/health` reports `clockSkewSeconds` and the drift is visible rather
than mysterious.

⚠ **A phase is not a status.** `Sale.status` stays `Open` on chain from creation until someone
launches, so a UI keyed on it keeps offering buys after the window has shut. `phaseOf()` in
`web/src/token.jsx` is the single derivation, shared by the listing and the sale page so the two
cannot disagree.

⚠ **The indexer being down is a stated condition, not an empty list.** An empty launchpad and an
unreachable service look identical otherwise, and only one of them is worth investigating.

---

## Money and rent

| | |
|---|---|
| `LAUNCH_RESERVE`, prefunded by the creator | **0.045 SOL** — a measured launch spends 0.0251 of it (mint, curve, curve token account, metadata, the vault's ATA) |
| what the creator gets back | whatever is unspent, via `sweep_lamports`. ⛔ There is no UI button for this yet |
| attester cost per buyer | ~0.0045 SOL — position rent, receipt rent, and the buyer's token account |
| attester float | 0.3 SOL ≈ 65 buyers. It logs `⚠ ATTESTER LOW` under 0.05 SOL, **and nothing alerts anyone yet** |

⭐ The reserve is generous on purpose. Whatever is unspent goes straight back to the creator, so a
larger reserve costs nothing and removes the "the launch reverted for 0.001 SOL" failure mode.

---

## Running it

⛔ **Dependencies install in TWO places**, and a clone that installs only one of them fails with
`Rolldown failed to resolve import "@solana/web3.js" from fees.mjs`. The root holds the program
client, the curve and the watcher; `web/` holds the site, and the site imports the root's modules.

```bash
npm install && (cd web && npm install)
```

```bash
./run-integration.sh          # build (test-attester), local validator with pump.fun cloned, full suite
node indexer/upload.test.mjs  # the logo upload proxy
node watcher/pass.test.mjs    # the watcher's pass planner, against fakes
./rehearse-mainnet.sh         # the go-live path, rehearsed on a local chain
./verify-program.sh           # is the program on mainnet this source? (no key needed)
```

The program's own unit tests, and the vectors the differential suite reads, come from the Rust
side. ⚠ Use the sbpf host toolchain and `--locked`, never the system cargo (see TOOLCHAIN.md):

```bash
cargo +1.89.0-sbpf-solana-v1.53 test --manifest-path programs/pumpfamily/Cargo.toml --lib --locked --features test-attester
cargo +1.89.0-sbpf-solana-v1.53 test --manifest-path programs/pumpfamily/Cargo.toml --lib --locked vectors   # writes vectors.json
node differential.test.mjs
```

`vectors.json` is deliberately not committed — it is the OUTPUT under test. A clone that runs
`node differential.test.mjs` first gets a message saying exactly this.

✅ Green on **19 Sep 2026**, run in that order: the lifecycle suite **72**, the indexer **49**, the
curve **51**, the market **26**, the differential **200 vectors × 5 fields**, the program's own unit
tests **17**, and the upload proxy **9**.

⭐ The lifecycle suite runs against the **real Raydium pool cloned from mainnet**, so the swap in it
is a real swap at a real price. Its two load-bearing assertions are `the swap cost 0.251% against
the quoted rate` and `the ratio between them is untouched by the swap` — the second is the fairness
claim written as a test.

⭐ The differential suite is the one worth understanding: `curve.rs` and `curve.mjs` are two
implementations of the same arithmetic, and two implementations are exactly where a rounding
divergence hides. A divergence means the allocation the program books and the number shown to the
buyer disagree, so the JS is checked base unit for base unit against vectors the Rust emits.

⚠ **Build with release 4.0.0, named directly**: `~/.local/share/solana/install/active_release` is
symlinked to 2.1.0 (rustc 1.79, cannot parse edition-2024 deps) and other tooling flips it back.

⚠ `--bpf-program` loads the `.so` at **genesis**. A validator left running from an earlier build
serves the OLD program, and a changed instruction signature then shifts every argument offset —
surfacing as `memory allocation failed, out of memory` (a bogus string length read from the wrong
bytes), which looks nothing like a version mismatch. `run-integration.sh` always restarts.

⚠ The validator uses port **8999**: 8899 collides with launchdeck's executor, which answers
`method getVersion does not exist` and reads like a broken validator.

### A local demo, for UI work

```bash
./validator.sh &
node demo/serve.mjs &
node demo/make-demo.mjs                       # prints the lookup table
RPC_URL=http://127.0.0.1:8999 INDEXER_DB=/tmp/x.db node indexer/server.mjs &
cd web && VITE_LAUNCH_LUT=<lut> npx vite      # http://localhost:5240
```

### Shipping

See `DEPLOY.md`. In short: `VITE_LAUNCH_LUT=… ./deploy.sh` for the site, `server/install-app.sh`
plus a restart for the services, `./upgrade-mainnet.sh` for the program.

⚠ **Not in the public repository.** `DEPLOY.md`, `HANDOFF.md`, `rehearse-mainnet.sh` and every
deploy script describe one particular server — its address, its units, its key paths — rather than
the software, so they are withheld. Nothing in this section is needed to read, build or test the
code; everything under *Running it* works without them, apart from `rehearse-mainnet.sh`.

---

## ⛔ Known gaps

- **The close has never run on mainnet.** ✅ The *buy* side is proven with real money: a FOMO web
  withdrawal was credited on mainnet on 21 Sep 2026, which settles the largest assumption in the
  system — FOMO web sends **do** carry the co-signature — and the refund path is proven too, since
  that sale missed its minimum and returned every unit to the sender. ⛔ What has never run against
  the real chain is the other half: the swap, `create_v2`, and delivery. Green on a local validator
  with pump.fun cloned, never once on mainnet.
- **No rent reclaim** for the attester: it spends ~0.0045 SOL per buyer and nothing tops it up.
  (It does now warn when it runs low — `watcher/alert.mjs`.)
- **No UI** for `sweep_lamports`, so a creator's unspent launch reserve needs a command.
- **Not audited.** The operator decided against commissioning one; that decision is made. What
  exists instead is an adversarial suite written by the author of the program, which narrows where
  a hole could be and does not make the program audited. ⭐ An **outside review on 22 Sep 2026**
  reported six findings. The three code defects — sale-shaped bytes accepted at any address, no
  refund path once a swapped sale missed its deadline, and a self-claim that paid the unscaled
  allocation — are fixed and pinned by tests (`isProgramSale`, `refund_sol` / `refund_pair`,
  `scaled_payout`); the metadata fetch no longer reaches private addresses or follows redirects
  blindly. The three trust facts — one attester, one upgrade key, no audit — are stated above and
  on the site rather than argued with.
- **Dependencies.** `npm audit` reports one advisory with no fix in any release:
  `bigint-buffer` (GHSA-3gc7-fjrx-p6mg, a native-binding overflow in `toBigIntLE`), pulled in by
  `@solana/spl-token` for every Solana project on web3.js v1. It decodes fixed-width fields of
  chain data here, never attacker-sized buffers. The two that had fixes (`uuid`, `stream-json`,
  both under `jayson` inside web3.js) are pinned to patched versions through package overrides.
- **Not built** (deliberately, for now): custom pairs, video logo, banner, and mayhem mode — which
  `PUMPFUN-OPTIONS.md` shows is incompatible with a presale at all.
