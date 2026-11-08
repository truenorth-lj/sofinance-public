/**
 * The pool id is not a Raydium CLMM pool (no account, or another program owns it), so the live Raydium range APR
 * cannot apply. Lets `/api/pool-range-apr` answer "not tracked" (404) instead of an outage (503).
 */
export class NotRaydiumClmmPoolError extends Error {
  constructor() {
    super("Raydium CLMM pool account does not exist");
    this.name = "NotRaydiumClmmPoolError";
  }
}

/** Plain-language answer for a pool with no saved estimate and no live one (no codes; shown as is). */
export const POOL_NOT_TRACKED_MESSAGE = "There's no fee estimate for this pool yet.";
