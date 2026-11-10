import "@/lib/engine-host";
import "server-only";
/**
 * Plain-language error bodies for the spot-swap routes (copy rule: no codes or internals in the message; `code` is
 * only for the client's own branching and is never shown). Engine messages written for users pass through; internal
 * safety failures get one generic sentence.
 */
import { JupiterNoRouteError } from "@sofinance/engine/swap/jupiter";
import { SpotSwapError, type SpotSwapErrorCode } from "@sofinance/engine/spot-swap";
import { selectedApiError } from "@/lib/api-response";
import { FEE_ESTIMATE_USER_MESSAGE, isTransientFeeEstimateError } from "@/lib/rpc-fee-estimate";
import { captureApiRouteError } from "@/lib/sentry/capture";
import { logSafeError } from "@/lib/safe-error-log";
import { isUpstreamRelayPending, upstreamUnavailable } from "@/lib/upstream-errors";
import { SpotSwapNoRouteError } from "@/server/transactions/spot-swap";

/** Plain sentences per user-actionable code; `null` = the engine's message is already written for users. */
const USER_FACING: Partial<Record<SpotSwapErrorCode, string | null>> = {
  spot_swap_price_impact: null,
  spot_swap_fee_not_configured: null,
  spot_swap_quote_changed: null,
  spot_swap_amount_too_small: "This amount is too small to buy.",
  spot_swap_token_unavailable: "This stock token can't be bought right now.",
  spot_swap_token_not_allowed: "This stock token can't be bought in the app.",
  spot_swap_insufficient_usdc: "Not enough USDC in this wallet.",
  spot_swap_insufficient_sol: "Not enough SOL to cover the one-time deposit and the network fee.",
  spot_swap_state_changed: "Balances changed while we were checking. Please try again.",
};

export const SPOT_SWAP_SAFETY_MESSAGE = "We couldn't prepare a safe purchase for this amount, so nothing was prepared. Please try again.";
export const SPOT_SWAP_UNAVAILABLE_MESSAGE = "Buying is not available for this stock right now. Please try again later.";
const headers = { "Cache-Control": "no-store" };

export function spotSwapErrorResponse(error: unknown, fallback: string, route: string): Response {
  if (isUpstreamRelayPending(error)) throw error; // withJupiterRelay turns it into the 409 relay step
  if (upstreamUnavailable(error)) return selectedApiError(error, fallback);
  if (error instanceof SpotSwapError) {
    const status = error.code === "spot_swap_fee_not_configured" ? 503 : 400;
    const known = error.code in USER_FACING;
    const message = known ? USER_FACING[error.code] ?? error.message : SPOT_SWAP_SAFETY_MESSAGE;
    if (!known) logSafeError(fallback, error);
    const sol = error.code === "spot_swap_insufficient_sol" ? { sol: error.detail } : {};
    // The new route terms, for the modal to show and the user to confirm again (amounts only, no internals).
    const terms = error.code === "spot_swap_quote_changed" ? { quote: error.detail } : {};
    return Response.json({ error: message, code: error.code, ...sol, ...terms }, { status, headers });
  }
  if (error instanceof SpotSwapNoRouteError || error instanceof JupiterNoRouteError) {
    return Response.json({ error: new SpotSwapNoRouteError().message, code: "spot_swap_no_route" }, { status: 400, headers });
  }
  if (isTransientFeeEstimateError(error)) return Response.json({ error: FEE_ESTIMATE_USER_MESSAGE }, { status: 503, headers });
  logSafeError(fallback, error);
  captureApiRouteError(error, { fallback, status: 500, route });
  return Response.json({ error: fallback }, { status: 500, headers });
}
