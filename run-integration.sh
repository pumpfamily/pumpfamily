#!/usr/bin/env bash
# Build → restart validator → wait for readiness → run the end-to-end test.
#
# ⚠ `--bpf-program` loads the .so at GENESIS. A validator left running from a previous build serves
# the OLD program, and a changed instruction signature then shifts every argument offset — which
# surfaces as "memory allocation failed, out of memory" (a bogus string length read from the wrong
# bytes), not as anything resembling a version mismatch. Always restart after a build.
set -euo pipefail
cd "$(dirname "$0")"
export PATH="$HOME/.local/share/solana/install/releases/4.0.0/solana-release/bin:$PATH"
[ -f "$HOME/.launchdeck/.env" ] && { set -a; . "$HOME/.launchdeck/.env"; set +a; }
PORT="${LOCAL_RPC_PORT:-8999}"
# The local validator has no rate limit; the services default to a paced connection (rpc-pace.mjs).
export RPC_RPS=0

# ⛔⛔ One second, before a two-minute build. `cargo-build-sbf` compiles with the rustc inside
# Solana's platform tools (1.79), and any `cargo` run with the SYSTEM cargo can drift the lock to
# crates it cannot parse. The build then fails at RESOLUTION, naming a transitive crate nobody
# here depends on, one at a time. See TOOLCHAIN.md.
echo "── toolchain ──"
node check-toolchain.mjs

echo "── build ──"
cargo-build-sbf --features test-attester --sbf-out-dir target/deploy-test

echo "── restarting validator on :$PORT ──"
pkill -f "solana-test-validator.*--rpc-port $PORT" 2>/dev/null || true
sleep 2
LOCAL_RPC_PORT="$PORT" nohup ./validator.sh > validator.log 2>&1 &
for i in $(seq 1 60); do
  if solana -u "http://127.0.0.1:$PORT" cluster-version >/dev/null 2>&1; then break; fi
  sleep 1
done
solana -u "http://127.0.0.1:$PORT" cluster-version >/dev/null 2>&1 || { echo "validator did not come up"; tail -20 validator.log; exit 1; }
echo "validator up"

echo "── integration test ──"
export LOCAL_RPC="http://127.0.0.1:$PORT"
node fomo-sale.test.mjs
echo "── custom pairs ──"; node pair.test.mjs
echo "── indexer ──";      node indexer/indexer.test.mjs
echo "── metadata ──";     node indexer/metadata.test.mjs
echo "── curve ──";        node curve.test.mjs
echo "── market ──";       node market.test.mjs
echo "── decisions ──";    node check-decisions.mjs
echo "── advisories ──";   node check-audit.mjs
echo "── rpc pace ──";     node rpc-pace.test.mjs
echo "── watcher pass ──"; node watcher/pass.test.mjs
echo "── differential ──"; node differential.test.mjs
# ⚠ `--locked`. Without it this line can REWRITE Cargo.lock to versions the SBF toolchain cannot
# parse — the suite passes and the next `cargo-build-sbf` fails on a repository nobody edited.
echo "── program unit tests ──"; cargo test --locked -p pumpfamily --lib 2>&1 | grep "test result"
