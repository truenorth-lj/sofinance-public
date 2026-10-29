/**
 * Code-level feature flags. These are deliberately constants, not env vars,
 * so a change is one reviewed line and a normal deploy.
 */

/**
 * Native SOL as the input asset when opening a new position.
 *
 * Temporarily `false` (2026-10-29): Phantom currently shows "Request blocked"
 * (malicious) for every open whose input is native SOL, while opens funded with
 * other tokens (e.g. SPCX, USDC) preview normally. Until the SOL → wSOL open
 * transaction is fixed, the open picker shows SOL as unavailable and the open
 * quote/prepare paths (app API and MCP) refuse native SOL input.
 *
 * To restore SOL input, flip this to `true`. Nothing else needs to change.
 */
export const SOL_INPUT_ENABLED = false;

export const SOL_INPUT_DISABLED_MESSAGE = "SOL deposits are temporarily unavailable — please use another token.";
