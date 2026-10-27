import type { RpcErrorKind } from "./types";

const STRUCT_VALIDATION = /At path:|Expected a .+ but received|Expected the value to satisfy a union/i;
const HTTP_STATUS = /\b([4-5]\d\d)\b/;

export const RPC_UNAVAILABLE_MESSAGE =
  "Solana RPC is temporarily unavailable. Please retry in a moment.";

export class RpcHttpError extends Error {
  readonly status: number;
  readonly retryAfterMs: number | null;
  constructor(status: number, message: string, retryAfterMs: number | null = null) {
    super(message);
    this.name = "RpcHttpError";
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

export class RpcUnavailableError extends Error {
  constructor(cause?: unknown) {
    super(RPC_UNAVAILABLE_MESSAGE);
    this.name = "RpcUnavailableError";
    if (cause !== undefined) this.cause = cause;
  }
}

export function isRpcStructValidationError(error: unknown): boolean {
  return classifyRpcError(error) === "validation";
}

export function isTimeoutError(error: unknown): boolean {
  if (error instanceof Error && error.name === "TimeoutError") return true;
  const message = error instanceof Error ? error.message : String(error);
  return /timeout|timed out|aborted due to timeout/i.test(message);
}

export function isUserAbort(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) {
    return !isTimeoutError(signal.reason);
  }
  return error instanceof Error && error.name === "AbortError" && !isTimeoutError(error);
}

export function abortError(signal?: AbortSignal): Error {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}

const AUTH_STATUS = new Set([401, 402, 403]);
/** Solami (and some others) encode rate-limit / unhealthy node as JSON-RPC -32005. */
const RATE_LIMIT_RPC_CODE = -32005;

function httpStatusOf(error: unknown): number | null {
  if (error instanceof RpcHttpError) return error.status;
  if (error && typeof error === "object") {
    const record = error as { status?: unknown; statusCode?: unknown };
    if (typeof record.status === "number") return record.status;
    if (typeof record.statusCode === "number") return record.statusCode;
  }
  return null;
}

function jsonRpcCodeOf(error: unknown): number | null {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code: unknown }).code;
    if (typeof code === "number" && Number.isFinite(code)) return code;
  }
  const message = error instanceof Error ? error.message : String(error);
  const tagged = message.match(/\bRPC\s+(-?\d+)\b/);
  if (tagged) return Number(tagged[1]);
  const embedded = message.match(/\bcode["']?\s*[:=]\s*(-?\d+)/i);
  if (embedded) return Number(embedded[1]);
  return null;
}

/**
 * Classify a thrown RPC / web3.js failure. 401/402/403 are `auth` (expired key
 * or lapsed plan); 429 and JSON-RPC -32005 are `rate-limit`; Superstruct shape
 * mismatches are `validation` (Solami non-compliance).
 */
export function classifyRpcError(error: unknown): RpcErrorKind {
  const status = httpStatusOf(error);
  if (status === 429) return "rate-limit";
  if (status !== null && AUTH_STATUS.has(status)) return "auth";
  if (status !== null && status >= 500) return "http-5xx";
  if (status !== null && status >= 400) return "http-4xx";
  if (isTimeoutError(error)) return "timeout";
  const message = error instanceof Error ? error.message : String(error);
  if (STRUCT_VALIDATION.test(message)) return "validation";
  const code = jsonRpcCodeOf(error);
  if (code === RATE_LIMIT_RPC_CODE || code === 429) return "rate-limit";
  if (/\b429\b|too many requests|rate[- ]?limit/i.test(message)) return "rate-limit";
  const http = message.match(HTTP_STATUS);
  if (http) {
    const parsed = Number(http[1]);
    if (AUTH_STATUS.has(parsed)) return "auth";
    return http[1]!.startsWith("4") ? "http-4xx" : "http-5xx";
  }
  if (/\bempty\b|no (?:result|transactions)\b/i.test(message)) return "empty";
  return "other";
}

/** JSON-RPC -32016: the provider has not yet reached the request's `minContextSlot`. */
export const MIN_CONTEXT_SLOT_RPC_CODE = -32016;

/** True when a provider answered "Minimum context slot has not been reached" (it is behind). */
export function isMinContextSlotError(error: unknown): boolean {
  if (jsonRpcCodeOf(error) === MIN_CONTEXT_SLOT_RPC_CODE) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /minimum context slot has not been reached/i.test(message);
}

export function shouldFallback(kind: RpcErrorKind, fallbackOn: readonly RpcErrorKind[]): boolean {
  return fallbackOn.includes(kind);
}

export function retryAfterFrom(error: unknown): number | null {
  return error instanceof RpcHttpError ? error.retryAfterMs : null;
}

export function isRetryableKind(kind: RpcErrorKind): boolean {
  return kind === "rate-limit" || kind === "http-5xx" || kind === "timeout";
}

export function asRpcUserError(error: unknown): Error {
  if (error instanceof RpcUnavailableError) return error;
  if (isUserAbort(error)) return error instanceof Error ? error : abortError();
  const kind = classifyRpcError(error);
  if (isRetryableKind(kind)) return new RpcUnavailableError(error);
  return error instanceof Error ? error : new Error(String(error));
}
