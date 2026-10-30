import "server-only";

import { JupiterRelayMissingError, jupiterRelayActive } from "@sofinance/engine/jupiter/client";
import { JupiterHttpError, JupiterUnavailableError, JUPITER_UNAVAILABLE_CODE, JUPITER_UNAVAILABLE_MESSAGE, RPC_UNAVAILABLE_CODE } from "@sofinance/engine/jupiter/errors";

/**
 * Upstream (Jupiter / RPC) error classification used by `api-response.ts`.
 * Kept here so the shared API response helper does not import the Jupiter modules itself;
 * every check below is the exact expression `api-response.ts` used inline before.
 */

/** Expected 409 protocol step: the browser still needs to fetch Jupiter (`withJupiterRelay` handles it). */
export function isUpstreamRelayPending(error: unknown): boolean {
  return error instanceof JupiterRelayMissingError;
}

/** Sentry tag: whether this request's Jupiter quotes came from the browser relay. */
export function upstreamQuotePath(): "browser" | "server" {
  return jupiterRelayActive() ? "browser" : "server";
}

/** Availability codes are never surfaced as `code` in an error body. */
export function isAvailabilityErrorCode(code: string): boolean {
  return code === JUPITER_UNAVAILABLE_CODE || code === RPC_UNAVAILABLE_CODE;
}

export const UPSTREAM_UNAVAILABLE_MESSAGE = JUPITER_UNAVAILABLE_MESSAGE;

/** Jupiter 429 / 5xx / unavailable: an availability error, not invalid user input. Null for anything else. */
export function upstreamUnavailable(error: unknown): { limited: boolean; retryAfterMs: number | null } | null {
  if (!(error instanceof JupiterHttpError && (error.status === 429 || error.status >= 500)) &&
    !(error instanceof JupiterUnavailableError)) return null;
  return {
    limited: error instanceof JupiterHttpError && error.status === 429,
    retryAfterMs: error instanceof JupiterHttpError ? error.retryAfterMs : null,
  };
}
