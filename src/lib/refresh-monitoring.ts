import { classifyObservedError, containsCredential } from "./observed-error";
import { sanitizePublicError } from "./public-error";
import { scrubSensitiveText } from "./sentry/scrub";

/** Sanitizer output, omitted when a connection string would still be present. */
export function messageIfSanitized(error: unknown, fallback: string): string | undefined {
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : undefined;
  if (!raw) return undefined;
  const sanitized = sanitizePublicError(error, fallback);
  if (!sanitized || containsCredential(sanitized)) return undefined;
  if (containsCredential(raw) && raw.includes(sanitized)) return undefined;
  return sanitized;
}

/** Stored issue text. The fallback replaces a message the sanitizer could not make safe. */
export function publicIssue(error: unknown, fallback: string, limit = 400): string {
  return (messageIfSanitized(error, fallback) ?? fallback).slice(0, limit);
}

/** Error safe to hand to Sentry: classification fields, and a message only when the sanitizer kept one. */
export function errorForMonitoring(error: unknown, fallback: string): Error {
  try {
    const fields = classifyObservedError(error);
    const safe = new Error(messageIfSanitized(error, fallback) ?? fallback);
    safe.name = fields.name;
    if (fields.pgCode) Object.assign(safe, { pgCode: fields.pgCode });
    if (fields.storeCode) Object.assign(safe, { code: fields.storeCode });
    if (fields.httpStatus !== undefined) Object.assign(safe, { status: fields.httpStatus });
    return safe;
  } catch {
    return new Error(fallback);
  }
}

/** Keep the original exception only when its message needs no scrubbing and has no connection string. */
export function exceptionForCapture(error: unknown, fallback: string): unknown {
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : undefined;
  if (raw !== undefined && (containsCredential(raw) || scrubSensitiveText(raw) !== raw)) return errorForMonitoring(error, fallback);
  return error;
}
