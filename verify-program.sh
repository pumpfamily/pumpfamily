#!/usr/bin/env bash
# Is the program on mainnet the program in this repository?
#
# Dumps the deployed bytecode and compares its sha256 with a fresh no-features build from this
# tree (the same build `deploy-program.sh` ships). Anyone with the repository can run this; it needs
# no key and sends nothing.
#
#   ./verify-program.sh                 # builds, then compares against mainnet
#   ./verify-program.sh --no-build      # compares against target/deploy/pumpfamily.so as it is
#
# ⚠ A deployed program's account is padded to its allocation, so the dump is compared over the
# length of the .so only, and the .so must not be LONGER than the dump.
set -euo pipefail
cd "$(dirname "$0")"
export PATH="$HOME/.local/share/solana/install/releases/4.0.0/solana-release/bin:$PATH"
RPC="${SOLANA_RPC_URL:-https://api.mainnet-beta.solana.com}"
PROGRAM=$(grep -o 'declare_id!("[^"]*")' programs/pumpfamily/src/lib.rs | cut -d'"' -f2)
SO="${SO:-target/deploy/pumpfamily.so}"
if [ "${1:-}" != "--no-build" ]; then
  echo "── build (no features) ──"
  node check-toolchain.mjs
  cargo-build-sbf --sbf-out-dir target/deploy
fi
[ -f "$SO" ] || { echo "no $SO"; exit 1; }
DUMP=$(mktemp -t pumpfamily-dump)
echo "── dump $PROGRAM from $RPC ──"
solana program dump -u "$RPC" "$PROGRAM" "$DUMP" >/dev/null
LEN=$(stat -f %z "$SO" 2>/dev/null || stat -c %s "$SO")
DLEN=$(stat -f %z "$DUMP" 2>/dev/null || stat -c %s "$DUMP")
[ "$DLEN" -ge "$LEN" ] || { echo "❌ the deployed program ($DLEN bytes) is SHORTER than the build ($LEN bytes)"; exit 1; }
LOCAL=$(shasum -a 256 "$SO" | cut -d' ' -f1)
ONCHAIN=$(head -c "$LEN" "$DUMP" | shasum -a 256 | cut -d' ' -f1)
TAIL=$(tail -c +"$((LEN + 1))" "$DUMP" | tr -d '\0' | wc -c | tr -d ' ')
echo "build    $LOCAL  ($LEN bytes)"
echo "on chain $ONCHAIN  ($DLEN bytes allocated, $TAIL non-zero bytes past the build)"
rm -f "$DUMP"
if [ "$LOCAL" = "$ONCHAIN" ] && [ "$TAIL" = "0" ]; then echo "✅ the deployed program is this source"; else echo "❌ MISMATCH — the deployed program is not this build"; exit 1; fi
