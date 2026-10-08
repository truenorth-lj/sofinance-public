import "server-only";

import { CompoundSendError, sanitizePublicError } from "./public-error";

export function apiError(error: unknown, fallback: string, status = 400, extra?: { sent?: boolean }) {
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
