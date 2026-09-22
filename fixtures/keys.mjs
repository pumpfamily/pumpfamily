/**
 * Stand-in keys for local validators only.
 *
 * ⛔⛔ Both secrets are committed. `TEST_ATTESTER` is the key a `--features test-attester` build
 * obeys, and `TEST_FOMO_COSIGNER` plays FOMO's co-signer for the watcher. Neither may ever sign
 * anything on mainnet, and `deploy-program.sh` rebuilds without features so neither can be in a
 * deployed program.
 */
import { readFileSync } from 'node:fs'
import { Keypair } from '@solana/web3.js'

const load = (f) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(new URL(f, import.meta.url), 'utf8'))))
export const TEST_ATTESTER = load('./attester-TEST.json')
export const TEST_FOMO_COSIGNER = load('./fomo-cosigner-TEST.json')
