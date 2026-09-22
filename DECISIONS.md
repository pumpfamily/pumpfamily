# Decisions — the rulings, each bound to the code that enforces it

Every time the operator rules on how the product behaves, it lands here as a numbered entry.
The title IS the ruling, so a grep of the headings is the policy index. `Enforced-in` names the
file and the exact symbol; `node check-decisions.mjs` verifies every one of them still exists,
so this file is an audit oracle and not a wish list. Append-only: a later ruling supersedes an
earlier one by reference, never by edit.

⛔ This file answers "why does the product DO this?". "Why did we BUILD it with X?" belongs in
README.md and TOOLCHAIN.md; operational history belongs in HANDOFF.md.

### PD-1 · A buy counts only if FOMO's co-signer signed the transaction that made it
**Decision:**    a transfer into a deposit account is credited iff `AgmLJBMDCqWynYnQiPCuj9ewsNNsBJXyzoUhD9LJzN51` signed it; anything else is returned to the sender
**Why:**         it is the only unforgeable marker that a send came from FOMO; the program cannot see earlier signers, so the attester reads it
**Rejected:**    a fee-wallet check (spoofable); asking FOMO for an integration (they never build into strangers' programs)
**Decided:**     2026-09-16 (operator, proven with real money 2026-09-21)
**Enforced-in:** watcher/attester.mjs (`fomo`); program.mjs (`MAINNET_FOMO_COSIGNER`)

### PD-2 · Hiding a sale is cosmetic and can never reach settlement
**Decision:**    the watcher always asks the indexer for hidden sales, forced in code, not configuration
**Why:**         `HIDDEN_SALES` once removed a live sale from the watcher's work list: no credits, no launch, no refund, every health check green
**Rejected:**    documenting "always set hidden=1 in watcher.env" (an operator can forget it)
**Decided:**     2026-09-21 (operator, after the FOMO test)
**Enforced-in:** watcher/run.mjs (`searchParams.set('hidden', '1')`)

### PD-3 · A launch window is at least an hour and at most seven days
**Decision:**    `launch_deadline - window_end` is 3,600..604,800 s on mainnet; the test build alone lowers the floor to 20 s so the suite can run a sale past its deadline
**Why:**         buyers must not be held forever by a creator who never launches, and the cranker needs time to land the swap and launch
**Rejected:**    a shorter mainnet floor (a swap plus create_v2 under load needs the hour)
**Decided:**     2026-08 (operator); test exception 2026-09-22
**Enforced-in:** programs/pumpfamily/src/lib.rs (`MIN_LAUNCH_WINDOW`)

### PD-4 · A window is at least a minute and at most thirty days
**Decision:**    `window_seconds` is 60..2,592,000
**Why:**         under a minute nobody can send; over a month the shadow curve's price is fiction
**Rejected:**    no floor (a zero-length window is a coin with no window)
**Decided:**     2026-08 (operator)
**Enforced-in:** programs/pumpfamily/src/lib.rs (`WindowTooShort`)

### PD-5 · One wallet may hold at most 3% of the supply, measured on what it sends
**Decision:**    a credit that would take a wallet past 3% of `TOTAL_SUPPLY` is returned; the cap is checked on the quoted allocation, before the close scales every position by one factor
**Why:**         a whale cannot take the window; several wallets are not prevented and the site says so
**Rejected:**    a cap on the scaled payout (unknowable until the close)
**Decided:**     2026-08 (operator); wording on the site 2026-09-22
**Enforced-in:** programs/pumpfamily/src/lib.rs (`MAX_WALLET_BPS`)

### PD-6 · Every payout is the quoted allocation scaled by what the raise actually bought
**Decision:**    `amount = allocation × tokens_received / sold`, floor, ONE formula for every route that pays a launched position
**Why:**         the swap's fee and impact land on everyone identically, so each wallet's share is exactly its share of the raise
**Rejected:**    paying the raw allocation on self-claims (it paid more and left the last deliveries short — outside review, 2026-09-22)
**Decided:**     2026-09-22 (operator)
**Enforced-in:** programs/pumpfamily/src/lib.rs (`scaled_payout`)

### PD-7 · A failed sale refunds in whatever the raise had become when it failed
**Decision:**    USDC still in the deposit account → USDC in full; already swapped to SOL → SOL pro rata on what remains; swapped on into a pair token → that token pro rata. A USDC refund on a swapped sale is refused.
**Why:**         a sale can swap and then miss its deadline; before this the SOL was stuck behind `sweep_lamports` forever and every refund failed on an empty account
**Rejected:**    a reverse swap back to USDC (an attacker-shaped route, slippage, and still pro rata)
**Decided:**     2026-09-22 (operator, outside review)
**Enforced-in:** programs/pumpfamily/src/lib.rs (`refund_sol`, `refund_pair`, `SwappedRefund`)

### PD-8 · Sale-shaped bytes are not a sale
**Decision:**    an account is shown or acted on as a sale only if the program owns it, it carries the Sale discriminator, and its address equals `["sale", authority, sale_id]`
**Why:**         a page would otherwise show an attacker's deposit account under our name (outside review, 2026-09-22)
**Rejected:**    trusting the indexer's listing alone (the site reads addresses from URLs)
**Decided:**     2026-09-22 (operator)
**Enforced-in:** program.mjs (`isProgramSale`); web/src/chain.js (`isProgramSale`); indexer/indexer.mjs (`isProgramSale`); watcher/attester.mjs (`readSale`)

### PD-9 · Credits close a minute after the window, and never later than fifteen minutes
**Decision:**    the attester closes credits once every in-window transfer is decided and `window_end + 60 s` has passed; if it is dead, anyone may launch or fail the sale after `CREDIT_GRACE` = 15 min
**Why:**         a minute lets confirmed transfers settle; a dead attester must not hold money hostage
**Rejected:**    closing at `window_end` exactly (a transfer confirmed seconds later would be refused)
**Decided:**     2026-08 (operator)
**Enforced-in:** watcher/attester.mjs (`settleSeconds = 60`); programs/pumpfamily/src/lib.rs (`CREDIT_GRACE`)

### PD-10 · Dust is never returned, and a stranger gets three returns
**Decision:**    a send under 1 USDC is left where it is; a sender outside FOMO is returned at most 3 times; the attester never creates the sender's token account
**Why:**         every return costs the attester rent; without floors anyone could drain it by spraying
**Rejected:**    returning everything (the attester is 0.3 SOL of float)
**Decided:**     2026-09 (operator)
**Enforced-in:** watcher/attester.mjs (`returnMinimum = 1_000_000n`, `MAX_FOREIGN_RETURNS_PER_SENDER`)

### PD-11 · The coin's address ends in "fomo", and is chosen at launch from a random nonce
**Decision:**    the mint is ground at launch time; nobody can know the address early enough to pre-create its curve accounts
**Why:**         pump.fun's `create_v2` curve USDC ATA is non-idempotent — pre-creating it blocks the launch forever
**Rejected:**    fixing the mint at open (griefable)
**Decided:**     2026-09-18 (operator)
**Enforced-in:** programs/pumpfamily/src/lib.rs (`VANITY_SUFFIX`); vanity.mjs (`grind`)

### PD-12 · The listing picks the tier, never whether a sale is worked
**Decision:**    open sales get the full treatment every pass; settled sales are checked in a rotating slice every 20 passes and in full only when their fingerprint moved; a status-0 sale on chain always gets the full pass
**Why:**         re-reading every finished sale's history every 15 s saturated the RPC key and stalled real credits
**Rejected:**    skipping sales by the indexer's status alone (a display filter reaching the machinery — PD-2)
**Decided:**     2026-09-22 (operator)
**Enforced-in:** watcher/pass.mjs (`SETTLED_EVERY`, `planPass`)

### PD-13 · Every RPC call is paced in-process, under the key's burst limit
**Decision:**    the watcher keeps 5 requests/s and the indexer 4/s on the shared key (limit ~10/s); the local suite runs unpaced
**Why:**         the limit counts bursts, and sequential await chains are bursts; averages never exceeded it while 429s never stopped
**Rejected:**    retrying behind the limit (each retry is a delay and sometimes a failed attest)
**Decided:**     2026-09-22 (operator)
**Enforced-in:** rpc-pace.mjs (`pacing`); watcher/run.mjs (`rpsFromEnv(5)`); indexer/indexer.mjs (`rpsFromEnv(4)`)

### PD-14 · A creator's metadata URI is fetched only from public addresses
**Decision:**    the host and every redirect hop must resolve only to public addresses; the body is cut at 64 KB mid-stream
**Why:**         the URI is creator-written and fetched from inside the box (outside review, 2026-09-22)
**Rejected:**    an allowlist of gateways only (creators host metadata anywhere)
**Decided:**     2026-09-22 (operator)
**Enforced-in:** indexer/indexer.mjs (`fetchPublic`, `isPublicAddress`, `MAX_METADATA_BYTES`)

### PD-15 · The attester warns at 0.05 SOL, counting ~0.0045 SOL per buyer
**Decision:**    below 0.05 SOL the watcher logs and alerts (when `ALERT_WEBHOOK` is set); an unreadable balance is not low
**Why:**         it pays every credit, return and delivery; a dry attester stalls every sale
**Rejected:**    alerting on a failed read (teaches the reader to ignore it)
**Decided:**     2026-09-21 (operator)
**Enforced-in:** watcher/alert.mjs (`LOW_LAMPORTS`, `LAMPORTS_PER_BUYER`)

### PD-16 · The word "blink" never appears — it is a "window"
**Decision:**    not in copy, code, API fields or docs
**Why:**         operator's naming ruling
**Rejected:**    —
**Decided:**     2026-08 (operator)
**Enforced-in:** check-decisions.mjs (`FORBIDDEN_WORDS`)

### PD-17 · The public repository is one squashed commit with the infrastructure withheld
**Decision:**    `publish-public.sh` stages a scanned file set, resolves every import, and force-pushes a single commit; deploy scripts, systemd units and internal notes never go
**Why:**         the private history holds accidentally committed local keypairs; a fresh commit cannot leak them
**Rejected:**    pushing the branch history
**Decided:**     2026-09-18 (operator)
**Enforced-in:** publish-public.sh (`squashed`)

### PD-18 · Production changes go through three scripts and nothing else
**Decision:**    program + services + site together: `upgrade-mainnet.sh`; services alone: `server/install-app.sh` (which restarts them and stops on any guard); site alone: `deploy.sh`. An ad hoc `ssh … systemctl restart` or file edit on the box is not a deploy path.
**Why:**         the guards live in the scripts; on 2026-09-22 a manual restart chain ran after a guard had refused the ship and crash-looped the watcher for 80 s
**Rejected:**    documenting care (the failure was a `&& … | tail` that swallowed an exit code)
**Decided:**     2026-09-22 (operator)
**Enforced-in:** server/install-app.sh (`RESTART`); DEPLOY.md (`Two paths`)

### PD-19 · Dependency advisories may only decrease
**Decision:**    `audit-baseline.json` lists the advisories accepted today (one, `bigint-buffer`, with no fixed release anywhere); `check-audit.mjs` fails on any advisory not in it and asks for the baseline to be tightened when one disappears
**Why:**         a new advisory must not hide behind the accepted ones
**Rejected:**    `npm audit` as a report nobody reads
**Decided:**     2026-09-22 (operator)
**Enforced-in:** check-audit.mjs (`audit-baseline.json`)

### PD-20 · Ten accounts per read on publicnode, a hundred on a keyed provider
**Decision:**    `RPC_BATCH` defaults to 10 and the service env sets 100 on Helius
**Why:**         publicnode 403s a batch of 15; Helius takes the protocol's 100 and the indexer's refresh drops to a tenth of the calls
**Rejected:**    100 everywhere (every refresh threw on publicnode)
**Decided:**     2026-09-18 (operator); 100 on Helius 2026-09-22
**Enforced-in:** program.mjs (`RPC_BATCH`)
