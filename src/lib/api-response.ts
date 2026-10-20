import "@/lib/engine-host";
import "server-only";

import { CompoundSendError, sanitizePublicError } from "./public-error";
import { JupiterHttpError, JupiterUnavailableError, JUPITER_UNAVAILABLE_MESSAGE } from "@sofinance/engine/jupiter/errors";
import { captureApiRouteError } from "./sentry/capture";

/** Selected upstream failures are availability errors, not invalid user input. */
export function selectedApiError(error: unknown, fallback: string) {
  if (!(error instanceof JupiterHttpError && (error.status === 429 || error.status >= 500)) &&
    !(error instanceof JupiterUnavailableError)) return apiError(error, fallback);
  captureApiRouteError(error, { fallback });
  const limited = error instanceof JupiterHttpError && error.status === 429;
  const retryAfterMs = error instanceof JupiterHttpError ? error.retryAfterMs : null;
  return Response.json({ error: limited ? "Jupiter rate limit reached. Please retry later." : JUPITER_UNAVAILABLE_MESSAGE,
    code: limited ? "jupiter_rate_limited" : "jupiter_unavailable",
    ...(retryAfterMs !== null ? { retryAfterMs } : {}),
  }, { status: 503, headers: { "Cache-Control": "no-store",
    ...(retryAfterMs !== null ? { "Retry-After": String(Math.ceil(retryAfterMs / 1000)) } : {}),
  } });
}

export function apiError(error: unknown, fallback: string, status = 400, extra?: { sent?: boolean; route?: string }) {
  captureApiRouteError(error, { fallback, route: extra?.route });
  // eslint-disable-next-line no-console
  console.error(fallback, error);
  if (error instanceof Error && error.cause !== undefined) {
    // eslint-disable-next-line no-console
    console.error(fallback, error.cause);
  }
  const source = error instanceof CompoundSendError && error.cause !== undefined ? error.cause : error;
  const body: { error: string; sent?: boolean } = { error: sanitizePublicError(source, fallback) };
  const sent = extra?.sent === false || error instanceof CompoundSendError && error.sent === false ? false : extra?.sent;
  if (sent === false) body.sent = false;
  return Response.json(body, {
    status, headers: { "Cache-Control": "no-store" },
  });
}
