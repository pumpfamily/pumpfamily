# pump.fun's launch options, read off the live program

Everything here was decoded from the **on-chain IDL and the live `Global` account** on 26 Aug 2026,
not from documentation or memory. Reproduce it with the snippets at the bottom.

> ## ✅ Where this stands on 18 Sep 2026
>
> This is a research log about **pump.fun**, and the pump.fun findings below still hold. What has
> changed is Pump Family: three things this file calls blockers have since been built and are live
> on mainnet. Read the log with that in mind.
>
> | this file says | today |
> |---|---|
> | "`create_v2` mints Token-2022, and that is the real blocker" | ✅ **built.** Every launch is `create_v2` + `buy_v2`, the coin is Token-2022, and the program spans both token programs through `token_interface` |
> | "a v2 launch does not fit in a legacy transaction" | ✅ **solved the way this file predicted** — one **shared, frozen** lookup table, `6rZuW7Kh9C5dGENPChACcyDd6vJ1KdT5XeFVEPvYb2uW`, and a v0 transaction |
> | "USDC quote mint — the launch half needs…" | ✅ **built.** USDC is the only denomination a live sale uses |
> | "they belong after the audit" | the operator decided **against** commissioning an audit. That decision is made — see `README.md` |
> | "the permanence analysis does not carry over to a Token-2022 mint unexamined" | ✅ **examined.** Both authorities read **none**: nobody can change the metadata, not even pump.fun. Decoded in `README.md` |
> | cashback | pump.fun **deprecated** it. The stored flag now means **holder rewards**, which are built and offered in the launch form |
> | mayhem | ⛔ still deliberately not offered, for the reason below — it is incompatible with a presale |
>
> ⛔⛔ And one finding that postdates this file entirely: **`create_v2` creates the curve's quote
> associated account NON-idempotently**, so anyone who learns a mint address in advance can create
> that account first and make the launch revert forever. Pump Family picks the mint **at launch**
> from a random nonce. See `README.md`.
>
> ## ⭐⭐ 21 Sep 2026 — `create_v2` makes a **SOL-paired** coin, quoted in WSOL
>
> Between 18 and 21 Sep this repo went to SOL pairing and, believing `create_v2` could not do it,
> moved the launch to **v1 `create`**. The reasoning was: `Global.whitelisted_quote_mints` holds
> USDC and nothing else, so WSOL is not a quote mint.
>
> ⛔⛔ **The whitelist reading was right and the conclusion was wrong.** WSOL never consults that
> list. Pass `So111…112` as `create_v2`'s `quote_mint` and pump.fun writes the curve's
> `quote_mint` as **all zeroes** — a native-SOL coin, priced and graduated like any other.
>
> ⭐ Proven, not reasoned: mainnet coin `7mCnMuMpvqY8rjqizGi28rvEh7PZjuZTZb3Prvx1pump`, launched
> 20 Sep, has `quote_mint` all-zeroes AND `is_holder_reward = 1`. Its creation instruction is
> `create_v2` with 19 accounts, account 16 = WSOL, and the dev buy is **`buy_exact_sol_in`**.
> Of the **70 newest coins on pump.fun, all 70** are `create_v2`; **none** uses v1 `create`.
>
> | | |
> |---|---|
> | Pump Family's launch | `create_v2` (WSOL) + `buy_exact_sol_in`, Token-2022 coin, SOL-paired |
> | creator rewards | **to the creator OR to holders**, chosen per sale — `is_holder_reward` is back |
> | ⛔ the trap | holder rewards make the curve's creator a `holder-rewards` PDA of the mint, so `creator_vault` is seeded on THAT, not on the creator. A launch built with the creator's own vault is refused |
>
> Still open, and still blocked on the outside world: **sharing creator rewards** needs one real
> `update_fee_shares_v2` transaction to read the account layout from — the last section of this file.

**The headline: one of these options is incompatible with the presale mechanic, and one changes
how token metadata works entirely.** Neither is obvious from the argument list.

---

## What exists

`create` and `create_v2` are both live. `Global.create_v2_enabled` is **true**.

| | `create` | `create_v2` |
|---|---|---|
| args | name, symbol, uri, creator | name, symbol, uri, creator, **is_mayhem_mode**, **is_cashback_enabled** |
| accounts | 14 | 16 |

Live switches in `Global`, all currently **on**: `create_v2_enabled`, `mayhem_mode_enabled`,
`is_cashback_enabled`, `enable_migrate`.

Also live: `buy_v2` / `sell_v2` (27 accounts, quote-mint aware), `add_quote_mint`,
`claim_cashback`, `claim_token_incentives`, `update_buyback_config`.

---

## 🔴 Mayhem mode cannot be offered here

The `BondingCurve` account carries `is_mayhem_mode`, and there is an instruction
`set_mayhem_virtual_params`. Its event says exactly what it does:

```
UpdateMayhemVirtualParamsEvent {
  virtual_token_reserves, virtual_sol_reserves,          // before
  new_virtual_token_reserves, new_virtual_sol_reserves,  // after
}
```

**It mutates the curve's virtual reserves after the coin exists.**

That is fatal for this product specifically. Pump Family quotes every deposit against a *mirrored*
curve during the window and only executes the real buy at the close, which can be days later. The
whole mechanism rests on the reserves being where we think they are when we finally buy. If
pump.fun can move them in between, every allocation booked in that window was priced against
numbers that no longer exist.

⭐ The money is not at risk, and that is by construction rather than by luck: `launch` re-reads the
vault's token balance and refuses to open claiming unless it covers every allocation, so a moved
curve makes the launch **revert** rather than under-deliver. The sale then fails and refunds. But a
launchpad whose launches revert is broken, so the correct answer is not to offer mayhem at all.

⛔ Do not add an `is_mayhem_mode` toggle to the create form.

---

## 🔴 `create_v2` mints **Token-2022**, and that is the real blocker

✅ **Superseded — this was built (16 Sep 2026).** The program speaks both token programs at once
through `anchor_spl::token_interface`: the coin is Token-2022 and the quote is classic SPL USDC.
The paragraph below is kept because the *reason* it was hard is still the reason to be careful
around the vault's balance read.

The account list settles the metadata question and raises a bigger one. `create_v2` pins:

```
token_program  address = TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb   // Token-2022
```

Classic `create` uses the original SPL token program. So a `create_v2` coin is a **Token-2022
mint**, which is why the Metaplex accounts are gone: its metadata lives in the mint's own extension
instead of a separate Metaplex account.

⛔ **This makes cashback a program-wide change, not a flag.** Pump Family is built on
`anchor_spl::token` end to end: the vault's associated token account, the transfer in `claim`, and
the `spl_token::state::Account::unpack` that backs the `tokens_received >= sold` guard — the single
most important check in the program. All of it would need the Token-2022 path, and the invariant
that reads the vault's balance after the CPI is exactly the code you least want to rewrite
casually.

⭐ It probably improves the permanence story rather than worsening it, since Token-2022 metadata can
carry its own update authority where Metaplex's is held by pump.fun with `is_mutable = false`. That
is worth confirming on a real `create_v2` mint before relying on it either way.

### The accounts, for when this is built

```
mayhem_program_id  MAyhSmzXzV1pTf7LsNkrNwkWKTo4ougAJ1PPg47MD4e   (fixed address)
global_params      PDA ["global-params"]        under the mayhem program
sol_vault          PDA ["sol-vault"]            under the mayhem program
mayhem_state       PDA ["mayhem-state", mint]   under the mayhem program
mayhem_token_vault (no PDA in the IDL — derive from a real CreateV2 transaction)
```

⚠ All five are required whether or not `is_mayhem_mode` is set.

## Why the Metaplex accounts are gone

`create_v2` drops `mpl_token_metadata`, `metadata` and `rent`. Token-2022 keeps metadata in the
mint's own extension, so there is no separate account to write.

⚠ The permanence warning (now in `README.md`) was written against the Metaplex path — `is_mutable =
false`, update authority held by pump.fun's `mint-authority` PDA. **That analysis does not carry
over to a Token-2022 mint unexamined**, and this design fixes the URI when a sale *opens*, days
before the mint exists, so it is the one to re-establish first.

---

## ✅ The `create_v2` recipe, read off a real USDC launch

Ground truth from `CAA37EB8VnDD97MvDZKfHgChKbLNxD435WATp1Mgpump`, creation transaction
`4uBz6ctHNrTExSV7B6nmDFV1483N7XGRf6MEPKvjjPVh7qvKPgkGNMQbWW2nygkudKFEBgTpF2Qoy8XJggj38S4Z`.

⭐ **It takes 19 accounts, not the 16 the IDL lists.** A quote-mint launch appends three.

```
 0  mint                       (signer, writable)   Token-2022 mint
 1  mint_authority             TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM
 2  bonding_curve              PDA ["bonding-curve", mint]
 3  associated_bonding_curve   ATA(bonding_curve, mint, TOKEN_2022)      ✔ derived, matches
 4  global                     4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf
 5  user                       (signer, writable)
 6  system_program
 7  token_program              TOKEN_2022
 8  associated_token_program
 9  mayhem_program_id          MAyhSmzXzV1pTf7LsNkrNwkWKTo4ougAJ1PPg47MD4e
10  global_params              13ec7XdrjF3h3YcqBTFDSReRcUFwbCnJaAQspM4j6DDJ
11  sol_vault                  BwWK17cbHxwWBKZkUYvzxLcNQ1YVyaFezduWbtm2de6s
12  mayhem_state               PDA ["mayhem-state", mint] under the mayhem program
13  mayhem_token_vault         3MTCHV3CocNRtgZYh9DKjV1dwhMgxsaCcKcYSZ2bDaRC
14  event_authority            Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1
15  program                    pump
── appended only for a quote-mint launch ──────────────────────────────────────────────
16  quote_mint                 EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v   (USDC)
17  associated_quote_curve     ATA(bonding_curve, USDC, TOKEN_CLASSIC)   ✔ derived, matches
18  quote_token_program        TOKEN_CLASSIC   (USDC is a classic SPL token, the base is not)
```

Args, in order: `name`, `symbol`, `uri` as Borsh strings, then `creator` (32 bytes), then
`is_mayhem_mode` (1 byte) and `is_cashback_enabled` (1 byte). The observed launch sent
`is_mayhem=0`, `cashback=01`, which is what confirms `OptionBool` is a plain byte.

⭐ **Both derived accounts were checked against the real transaction and match exactly**, so the
addresses above are reproducible rather than copied.

✅ All four new accounts are now cloned by `validator.sh`, so this path can be exercised locally.

⚠ Note the two token programs in one instruction: the coin is **Token-2022** and USDC is
**classic SPL**. Anything built here handles both at once.

## 🔴 A v2 launch does not fit in a legacy transaction

✅ **Solved, exactly as the ⭐ note below proposed**: one shared table, created once, **frozen**,
and every launch sent as a v0 transaction. The table is `6rZuW7Kh9C5dGENPChACcyDd6vJ1KdT5XeFVEPvYb2uW`
(`keys/launch-lut-mainnet.txt`), and `deploy.sh` refuses to build a site without it.

Measured on the real USDC launch rather than estimated:

```
version                v0
unique accounts        34   (17 static, 17 from a lookup table)
address lookup tables  1
serialized size        1017 bytes   (limit 1232)
```

**It used an address lookup table, and it still came to 1017 bytes.** Thirty-four accounts at 32
bytes each is 1,088 bytes of keys on their own, so without the table this cannot be built at all.

That matters here because Pump Family's `launch` is a **legacy transaction** today. It fits — 1,074
bytes with 18 accounts — because `create` and `buy` are CPIs from one instruction, so only that
instruction's accounts are declared. A v2 launch declares roughly double.

⭐ The fix is one **shared** table, not one per launch: almost every account involved is constant
across launches — `global`, `fee_config`, `fee_program`, `event_authority`, both token programs,
the associated-token program, the mayhem accounts, the buyback recipients. Only the mint, the
curve, its two associated accounts and the vault's differ.

⚠ It is still real machinery: creating the table once, storing its address, waiting a slot for it
to activate, building the launch as a **v0** transaction instead of a legacy one, and teaching
`browser-tx.test.mjs` to sign v0. None of that is hard; all of it is work that has to exist before
a single quote launch can land.

## Quote mints: USDC is whitelisted, with a different curve

`Global` carries a second set of curve constants and a whitelist:

```
initial_virtual_sol_reserves    30000000000       (30 SOL)
initial_virtual_quote_reserves   4292000000       (4,292 USDC, 6dp)
whitelisted_quote_mints         [EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v]   // USDC
```

`BondingCurve` now has `quote_mint` and `virtual_quote_reserves` alongside the SOL fields.

Supporting this is a **program-level change**, not a form field. The vault would hold USDC, deposits
would be USDC, `split_deposit` and the whole shadow curve would need the quote constants rather than
the SOL ones, and the launch would use `buy_v2` with 27 accounts instead of `buy` with 18. Every
suite that asserts lamports would need a second pass in token units.

⚠ Note the decimals trap that has bitten this operator before: USDC is **6dp**, SOL is 9dp.

---

## ✅ `track_volume` — done

`pump.rs` now sends it. The IDL types it as `OptionBool`, a tuple struct wrapping one bool, so it
is a single byte and always present rather than a Borsh `Option`.

Verified by execution against the current mainnet program cloned locally: the launch buy lands,
`tokens_received == sold` exactly, 39/39 integration plus 9 browser-tx, 26 edges and 14 Rust.

⚠ **It costs compute.** The launch went from **228,102 to 232,609 CU**, so volume accumulation does
real work inside pump.fun. Still far inside the limit, but worth knowing before anything else is
added to that transaction.

## Also in `Global`, worth knowing

```
buyback_basis_points        5000        // 50%
fee_basis_points              95
creator_fee_basis_points       5        // ⛔ the misleading one; the real creator leg is 30
```

The last line is the 125 bps trap documented in `README.md`, and it is still there: budgeting off
`Global` under-funds every launch by 25 bps. The real schedule comes from the fee program's
`get_fees`, which `fees.mjs` reads.

---

## Reproducing this

```js
// the IDL
const base = PublicKey.findProgramAddressSync([], PUMP)[0]
const idlAddr = await PublicKey.createWithSeed(base, 'anchor:idl', PUMP)
const acc = await conn.getAccountInfo(idlAddr)
const len = acc.data.readUInt32LE(40)
const idl = JSON.parse(zlib.inflateSync(acc.data.subarray(44, 44 + len)).toString())

// Global
const g = PublicKey.findProgramAddressSync([Buffer.from('global')], PUMP)[0]
```

⭐ The `Global` decode consumed **exactly** the account's 1045 bytes, which is what confirms the
field order above rather than a plausible-looking guess.

---

## Order of work — what is left

1. ✅ **`track_volume`** — done and verified.
2. ✅ **USDC quote mint, both halves** — `create_v2` + `buy_v2`, a Token-2022 coin, the shared
   lookup table, v0 transactions. Live on mainnet.
3. ✅ **Holder rewards** replaced cashback, which pump.fun deprecated. The curve's creator becomes
   `PDA["holder-rewards", mint]` and `buy_v2`'s `creator_vault` follows it.
4. ⛔ **Mayhem** — no, and not for want of work: it mutates the curve's virtual reserves after the
   coin exists, which is incompatible with pricing a presale against that curve.
5. ⏳ **Sharing creator rewards** — still blocked on one real `update_fee_shares_v2` transaction to
   read the layout from. Everything up to the split is proven; five layouts were falsified and the
   encoder now refuses to guess.
6. **Not built, and nobody has asked**: custom pairs, video logo, banner.


---

# Share creator rewards, and what cashback really costs — decoded 28 Aug 2026

## 🔴 Cashback takes the creator's ENTIRE fee, and was hard-coded on

`launch_quote` passed `is_cashback_enabled = true` for every quote launch, with a source comment
claiming it "is a rebate to traders and costs this sale nothing". Measured instead of believed, by
launching the same sale twice with only the flag different (`cashback.test.mjs`):

| | creator's fee vault, from a 160 USDC raise |
|---|---|
| cashback **off** | **0.474075 USDC** |
| cashback **on** | **0** |

0.474 USDC is 30 bps of the raise — the whole creator leg. Cashback does not reduce the creator's
reward, it **takes all of it** and pays it to traders. Every USDC sale was giving its creator
revenue away. It is now a per-sale choice, default **off**, refused on a SOL sale because `create`
v1 carries no such flag.

⚠ The creator fee on a `create_v2` coin is paid in the **quote mint**, into
`ATA(PDA["creator-vault", creator], quote_mint)` — not in lamports.

✅ **A creator CAN launch their own sale.** An earlier note here claimed a quote launch paid for by
the sale's own authority fails with `InsufficientFundsForRent` — that was **wrong**, and it was my
harness rather than the product. Tested directly: the sale's authority as both cranker and fee
payer launches successfully. The original failure came from somewhere else in that scratch setup.
The sale page's "Launch it" button uses the connected wallet, so this mattered.

## Share creator rewards lives in a DIFFERENT PROGRAM

⛔ **It is not a `create` argument.** Nothing in the bonding-curve program writes a `SharingConfig`
— every instruction there only reads one. The feature is in the fee program,
**`pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ`** (the same one that answers `get_fees`), and it is
**two transactions after the coin exists**. pump.fun's form saying "your split is applied when you
create the coin" describes its own UI, not the chain.

```
create_fee_sharing_config   disc [195,78,86,76,111,52,251,213]   13 accounts (3 optional)
update_fee_shares_v2        disc [111,251,49,6,78,78,106,18]      19 accounts + remaining
revoke_fee_sharing_authority                                      ⛔ accounts list is EMPTY in the IDL
SharingConfig               PDA ["sharing-config", mint] under the fee program
  { bump, version, status, mint, admin, admin_revoked, shareholders: Vec<{address, share_bps}> }
```

### ✅ Proven on a real launched coin

- `create_fee_sharing_config` lands.
- **It repoints the bonding curve's `creator` at the sharing config PDA**, which is what makes
  later fees accrue somewhere a split can reach. ⚠ Fees earned BEFORE this stay in the original
  creator's vault; sharing set up late splits nothing retroactively.
- The config is created holding **one recipient — the creator at 100%**, which is exactly what the
  form shows as "1 fee recipient selected". Sharing starts as a no-op split, not an empty one.
- Shares are **basis points totalling exactly 10,000**; duplicates rejected (`InvalidShareTotal`,
  `DuplicateShareholder`, `TooManyShareholders`).
- ⚠ `pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA` must be cloned onto the validator — Anchor
  checks it is executable even though a pre-graduation coin never touches the AMM. Added.

### ⛔ `update_fee_shares_v2` is NOT yet encodable — where it stops

It takes **remaining accounts the IDL does not describe**, and four attempts each moved the error
rather than clearing it:

| remaining accounts passed | result |
|---|---|
| the NEW shareholders | `ShareholderAccountMismatch` (fee program :212) |
| their token accounts | `ShareholderAccountMismatch` |
| the CURRENT shareholders only | `NotEnoughRemainingAccounts` (fee program :210) |
| new then current, concatenated | `ShareholdersAndRemainingAccountsMismatch`, thrown from inside **pump's** `distribute_creator_fee_v2` |

What that triangulates: the instruction **CPIs into `distribute_creator_fees_v2` to flush fees
accrued under the OLD split before writing the new one**, so the slice must satisfy the fee
program's check against the new list *and* the pump program's check against the old one.

⭐ **Next thing to try:** configure sharing on a coin with **nothing accrued**, where the distribute
step has nothing to do. Failing that, read the layout off a real `update_fee_shares_v2` transaction
on mainnet — the method that settled `create_v2`'s account list here.

### ⛔ Five layouts tried, all rejected — and the encoder now refuses

| remaining accounts passed | result |
|---|---|
| the NEW shareholders | `ShareholderAccountMismatch` (fee :212) |
| their token accounts | `ShareholderAccountMismatch` (fee :212) |
| the CURRENT shareholders only | `NotEnoughRemainingAccounts` (fee :210) |
| new then current | `ShareholdersAndRemainingAccountsMismatch` (pump distribute :112) |
| current then new | `ShareholdersAndRemainingAccountsMismatch` (pump distribute :112) |

⚠ The last was also run against a coin with **zero accrued creator fees**, which kills the obvious
theory that the distribute check only bites when there is something to distribute. It is
unconditional.

⛔ **`updateFeeSharesIx` now THROWS unless handed an explicit layout.** There is no default, on
purpose: this writes an irreversible split of someone's revenue, and a plausible guess that lands
is worse than one that fails.

**What would settle it:** one real mainnet `update_fee_shares_v2` transaction, read the way
`create_v2`'s account list was read here. As of 28 Aug 2026 there was none to find — 200 sampled
fee-program transactions contained only `get_fees`, and `getProgramAccounts` is 403-blocked on both
available endpoints, so a live `SharingConfig` could not be located either. The feature appears to
be too new to have traffic.

### The storage question this raises for Pump Family

A sale opens days before its coin exists, so a split chosen in the create form has to survive until
launch. It is **not** a `Sale` field yet, and making it one is a program change to code that
custodies deposits and has not been audited. The alternative is the indexer, which is a cache
nobody should trust with a payout instruction. **Decide this deliberately.**
