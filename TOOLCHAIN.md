# The Rust build, and why `Cargo.lock` is pinned down

`cargo-build-sbf` compiles the program with the toolchain that ships inside Solana's platform
tools — **rustc 1.79** — not with the rustc on this machine (1.9x). That is not a setting anyone
chose and it cannot be raised by upgrading the system toolchain.

## ⛔⛔ What breaks, and why it looks like nothing

Every `cargo test`, `cargo check` or `cargo build` run with the SYSTEM cargo may rewrite
`Cargo.lock` to newer dependency versions. The system cargo is happy with them. The SBF build then
fails at RESOLUTION, before a line of our code is read, with one of:

```
feature `edition2024` is required
rustc 1.79.0-dev is not supported by the following package
```

⛔ **The failing crate is never one we depend on directly.** On 21 Sep 2026 it was, in order:
`block-buffer 0.12.1` (via `blake3` → `digest 0.11`), `indexmap 2.14` (via `borsh-derive` →
`proc-macro-crate` → `toml_edit`), `zeroize 1.9`, `zeroize_derive 1.5` and
`unicode-segmentation 1.13`. Each one only surfaces once the one before it is fixed, so the
failure looks like a single bad crate five times running.

⚠ **It hits a repository that has not changed.** The build was green on 20 Sep and broke on its
own by the 21st, with no commit in between — crates.io published, the lock drifted, and the
toolchain stood still. So a broken SBF build is not evidence that the last edit broke anything.

## The pins

These exist for the toolchain, not for the program, and none is a feature choice:

| crate | pinned to | why |
|---|---|---|
| `blake3` | 1.5.5 | 1.8 pulls `digest 0.11` → `block-buffer 0.12` (edition2024) |
| `borsh` / `borsh-derive` | 1.5.7 | 1.8 pulls `proc-macro-crate 3.5` → `toml_edit 0.25` → `indexmap ^2.13` |
| `proc-macro-crate` | 3.2.0 | as above, the version that still allows `indexmap 2.7` |
| `indexmap` | 2.7.1 | 2.14 is edition2024 |
| `zeroize` | 1.8.1 | 1.9 is edition2024 |
| `zeroize_derive` | 1.4.2 | 1.5 is edition2024 |
| `unicode-segmentation` | 1.12.0 | 1.13 requires rustc 1.85 |

## Checking, without waiting for a two-minute build

`node check-toolchain.mjs` reads every package in `Cargo.lock`, finds its manifest in the cargo
registry (extracted source or the `.crate` archive, under either registry hash) and reports any
that declare `edition = "2024"` or a `rust-version` above 1.79. It is what the pins above were
found with, and it answers in under a second.

⚠ It can only judge a crate whose manifest is on disk. Run `cargo fetch` first, or a crate that
has never been downloaded is passed over in silence rather than reported.

To fix a new offender:

```sh
cargo fetch
node check-toolchain.mjs                      # names it
cargo update -p <name>@<locked> --precise <older>
node check-toolchain.mjs                      # confirm, then repeat — they surface one at a time
```

⛔ Pin the version that PULLS the offender when the offender itself cannot move: `indexmap` could
not be downgraded until `proc-macro-crate` was, and `proc-macro-crate` could not until `borsh`
was. The error message names the bottom of the chain and the fix is usually at the top of it.
