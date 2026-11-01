import { USDC_MINT } from "./ids";

/**
 * The exit preview converts everything to USDC and cannot yet account for a pool (or reward) that is
 * USDC itself. That is a known product limit, not a failure: the route answers 200 with
 * `status: "unsupported"` (never 503, never sent to Sentry) and the UI explains it in plain English.
 */
export const EXIT_PREVIEW_UNSUPPORTED_STATUS = "unsupported";
export const EXIT_PREVIEW_DIRECT_USDC_REASON = "direct_usdc";
export const EXIT_PREVIEW_DIRECT_USDC_MESSAGE =
  "Exit estimates aren't available yet for pools that hold USDC directly. You can still withdraw from the Withdraw tab, which shows its own preview.";

/** True when any of the pool's token mints (or reward mints) is USDC. Safe for client bundles. */
export function holdsUsdcDirectly(mints: readonly (string | null | undefined)[]): boolean {
  return mints.some((mint) => mint === USDC_MINT);
}

export function directUsdcExitPreview() {
  return {
    status: EXIT_PREVIEW_UNSUPPORTED_STATUS, reason: EXIT_PREVIEW_DIRECT_USDC_REASON, message: EXIT_PREVIEW_DIRECT_USDC_MESSAGE,
    netRecoveryUSDC: null, executable: false as const, sent: false as const,
  };
}
