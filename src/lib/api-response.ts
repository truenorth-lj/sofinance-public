import "@/lib/engine-host";
import "server-only";

import { CompoundSendError, publicErrorCode, sanitizePublicError } from "./public-error";
import { isAvailabilityErrorCode, isUpstreamRelayPending, UPSTREAM_UNAVAILABLE_MESSAGE, upstreamQuotePath, upstreamUnavailable } from "./upstream-errors";
import { SelectedNoRouteError } from "./selected-no-route";
import { captureApiRouteError, shouldCaptureApiError } from "./sentry/capture";
import { logSafeError } from "./safe-error-log";

/** Selected upstream failures are availability errors, not invalid user input. */
export function selectedApiError(error: unknown, fallback: string) {
  const unavailable = upstreamUnavailable(error);
  if (!unavailable) return apiError(error, fallback);
  if (shouldCaptureApiError(error, 503)) {
    captureApiRouteError(error, { fallback, status: 503, quotePath: upstreamQuotePath() });
  }
  const { limited, retryAfterMs } = unavailable;
  return Response.json({ error: limited ? "Jupiter rate limit reached. Please retry later." : UPSTREAM_UNAVAILABLE_MESSAGE,
    code: limited ? "jupiter_rate_limited" : "jupiter_unavailable",
    ...(retryAfterMs !== null ? { retryAfterMs } : {}),
  }, { status: 503, headers: { "Cache-Control": "no-store",
    ...(retryAfterMs !== null ? { "Retry-After": String(Math.ceil(retryAfterMs / 1000)) } : {}),
  } });
}

export function apiError(error: unknown, fallback: string, status = 400, extra?: {
  sent?: boolean;
  route?: string;
  request?: { url: string };
}) {
  // Expected 409 protocol step: the browser still needs to fetch Jupiter. Do not
  // log it as a route failure — `withJupiterRelay` turns this into `jupiter_relay_needed`.
  if (isUpstreamRelayPending(error)) throw error;
  if (shouldCaptureApiError(error, status)) {
    captureApiRouteError(error, {
      fallback, route: extra?.route, request: extra?.request, status,
      quotePath: upstreamQuotePath(),
    });
  }
  logSafeError(fallback, error);
  const source = error instanceof CompoundSendError && error.cause !== undefined ? error.cause : error;
  const body: { error: string; sent?: boolean; code?: string; inputMint?: string; outputMint?: string } = {
    error: sanitizePublicError(source, fallback),
  };
  const code = publicErrorCode(source);
  if (code && !isAvailabilityErrorCode(code)) body.code = code;
  if (source instanceof SelectedNoRouteError) {
    body.inputMint = source.inputMint;
    body.outputMint = source.outputMint;
  }
  const sent = extra?.sent === false || error instanceof CompoundSendError && error.sent === false ? false : extra?.sent;
  if (sent === false) body.sent = false;
  return Response.json(body, {
    status, headers: { "Cache-Control": "no-store" },
  });
}
