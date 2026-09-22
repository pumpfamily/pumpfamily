/**
 * Must be its own module, imported before anything else.
 *
 * ES module imports are hoisted and evaluated before any statement in the importing module's body,
 * so assigning `globalThis.Buffer` inside main.jsx runs AFTER @solana/spl-token has already been
 * evaluated and thrown `Buffer is not defined`. A separate module's side effects run in import
 * order, which is early enough.
 */
import { Buffer } from 'buffer'
globalThis.Buffer = globalThis.Buffer ?? Buffer
