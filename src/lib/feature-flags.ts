/**
 * Code-level feature flags. These are deliberately constants, not env vars,
 * so a change is one reviewed line and a normal deploy.
 */

/**
 * Native SOL as the input asset when opening a new position.
 *
 * Re-enabled (2026-10-29) after the native SOL protocol fee moved inside the
 * Jupiter swap (`platformFeeBps` into the fee wallet's pre-created wSOL ATA).
 * It was briefly `false` because Phantom showed "Request blocked" for opens
 * whose own instruction transferred SOL/wSOL straight to the fee wallet.
 *
 * Set to `false` to switch SOL input off again: the open picker then shows SOL
 * as unavailable and the open quote/prepare paths (app API and MCP) refuse
 * native SOL input. Nothing else needs to change.
 */
export const SOL_INPUT_ENABLED = true;

export const SOL_INPUT_DISABLED_MESSAGE = "SOL deposits are temporarily unavailable — please use another token.";
