import "@/lib/engine-host";
import "server-only";

import { CompoundSendError, sanitizePublicError } from "./public-error";
import { JupiterHttpError, JupiterUnavailableError, JUPITER_NO_ROUTE_CODE, JUPITER_UNAVAILABLE_MESSAGE } from "@sofinance/engine/jupiter/errors";
import { SelectedNoRouteError } from "./selected-no-route";
import { isJupiterNoRouteError, JupiterNoRouteError } from "@sofinance/engine/swap/jupiter";

/** Selected upstream failures are availability errors, not invalid user input. */
export function selectedApiError(error: unknown, fallback: string) {
  if (!(error instanceof JupiterHttpError && (error.status === 429 || error.status >= 500)) &&
    !(error instanceof JupiterUnavailableError)) return apiError(error, fallback);
  const limited = error instanceof JupiterHttpError && error.status === 429;
  const retryAfterMs = error instanceof JupiterHttpError ? error.retryAfterMs : null;
  return Response.json({ error: limited ? "Jupiter rate limit reached. Please retry later." : JUPITER_UNAVAILABLE_MESSAGE,
    code: limited ? "jupiter_rate_limited" : "jupiter_unavailable",
    ...(retryAfterMs !== null ? { retryAfterMs } : {}),
  }, { status: 503, headers: { "Cache-Control": "no-store",
    ...(retryAfterMs !== null ? { "Retry-After": String(Math.ceil(retryAfterMs / 1000)) } : {}),
  } });
}

export function apiError(error: unknown, fallback: string, status = 400, extra?: { sent?: boolean }) {
  // eslint-disable-next-line no-console
  console.error(fallback, error);
  if (error instanceof Error && error.cause !== undefined) {
    // eslint-disable-next-line no-console
    console.error(fallback, error.cause);
  }
  const source = error instanceof CompoundSendError && error.cause !== undefined ? error.cause : error;
  const body: { error: string; sent?: boolean; code?: string; inputMint?: string; outputMint?: string } = {
    error: sanitizePublicError(source, fallback),
  };
  if (source instanceof SelectedNoRouteError) {
    body.code = source.code;
    body.inputMint = source.inputMint;
    body.outputMint = source.outputMint;
  } else if (source instanceof JupiterNoRouteError || isJupiterNoRouteError(source)) {
    body.code = JUPITER_NO_ROUTE_CODE;
  }
  const sent = extra?.sent === false || error instanceof CompoundSendError && error.sent === false ? false : extra?.sent;
  if (sent === false) body.sent = false;
  return Response.json(body, {
    status, headers: { "Cache-Control": "no-store" },
  });
}
