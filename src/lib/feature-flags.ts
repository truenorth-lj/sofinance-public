/**
 * Code-level feature flags. These are deliberately constants, not env vars,
 * so a change is one reviewed line and a normal deploy.
 */

/**
 * Native SOL as the input asset when opening a new position.
 *
 * SOL deposits now open in two transactions (1/2: SOL -> pool token swap with
 * the 10 bps fee inside the Jupiter swap; 2/2: a token-input open sized from
 * what the swap delivered), because Phantom showed "Request blocked" for every
 * single-transaction SOL open variant (wrap + swap + Raydium open).
 *
 * Enabled after the two-step flow passed a Phantom and real-signing check on
 * a Vercel preview (PR #176). Set back to `false` to switch SOL input off: the
 * open picker then shows SOL as unavailable and the quote / prepare / swap-step
 * paths refuse native SOL. Vercel preview deployments (VERCEL_ENV=preview)
 * enable it regardless. Nothing else needs to change.
 */
export const SOL_INPUT_ENABLED = true;

export const SOL_INPUT_DISABLED_MESSAGE = "SOL deposits are temporarily unavailable — please use another token.";
