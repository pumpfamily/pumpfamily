/**
 * Pump Family's own token, and the launch gate that lifts when it exists.
 *
 * ## ⛔⛔ ONE VALUE CONTROLS BOTH
 *
 * `FAMILY_CA` is empty until the coin is live. While it is empty:
 *
 *   - **Launching is gated.** The Launch button opens a panel saying so instead of opening a sale.
 *   - The home page shows the ticker with the address still to come, rather than a dead link.
 *   - Nothing claims a market cap it cannot read.
 *
 * The moment a real mint address is set here, all of that reverses at once: the gate lifts, the
 * coin appears on the home page, in Explore, and on its own page. There is deliberately no second
 * switch to forget — a gate that can be left on after the reason for it is gone is worse than no
 * gate, and a coin that appears while launching is still blocked is worse still.
 *
 * ⚠ The coin is launched on ANOTHER platform, so this launchpad has no `Sale` account for it and
 * never will. It is shown as what it is: our token, with its address, its market and its page.
 * Nothing pretends there was a FOMO window.
 */

/**
 * The mint address, once it exists. ⛔ A Solana mint is 32 bytes in base58 — anything else here is
 * a typo, and `familyIsLive()` refuses it rather than rendering a link nobody can use.
 */
/**
 * The real address, written by `./go-family.sh <MINT> --yes` and by nothing else.
 *
 * ⛔ Its own line, on purpose: the script rewrites it by pattern, and keeping the preview override
 * out of that line means the two can never clobber each other.
 */
const CONFIGURED_CA = 'FvMLDEUDKUr9C34e8Nynz5Aqfdk34a2RBKQxygLpfomo'

/**
 * ⚠ `VITE_FAMILY_CA` overrides the above for a PREVIEW build only.
 *
 * It exists so the coin can be reviewed before it is real without editing this file — an edit
 * that is easy to forget to undo, and which would lift the launch gate on the next deploy with an
 * address that is not ours. ⛔ `deploy.sh` never sets it, so a production bundle always falls back
 * to `CONFIGURED_CA`.
 */
export const FAMILY_CA = (import.meta.env?.VITE_FAMILY_CA ?? '') || CONFIGURED_CA

export const FAMILY = {
  name: 'Pump Family',
  symbol: 'FAMILY',
  /** Served from web/public. Ours, so it does not depend on another platform's metadata. */
  image: '/family.png',
}

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/

/** True only for something that could actually BE a mint. An empty string is not "not yet" and a typo. */
export const familyIsLive = (ca = FAMILY_CA) => typeof ca === 'string' && BASE58.test(ca.trim())

/** ⛔ The gate is the inverse of the coin being live. There is no third state and no override. */
export const launchingDisabled = (ca = FAMILY_CA) => !familyIsLive(ca)
