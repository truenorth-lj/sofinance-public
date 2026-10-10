import { isTimeoutError } from "../rpc/errors";
import { parseRetryAfter } from "../rpc/retry";

export const JUPITER_UNAVAILABLE_MESSAGE =
  "Jupiter swap quotes are temporarily unavailable. Please retry in a moment.";
export const JUPITER_UNAVAILABLE_CODE = "jupiter_unavailable";
export const RPC_UNAVAILABLE_CODE = "rpc_unavailable";

export type JupiterErrorKind = "rate-limit" | "http-5xx" | "http-4xx" | "timeout" | "other";

export class JupiterHttpError extends Error {
  readonly status: number;
  readonly path: string;
  readonly retryAfterMs: number | null;
  readonly bodyError: string | null;

  constructor(status: number, path: string, retryAfterMs: number | null = null, bodyError: string | null = null) {
    super(`Jupiter HTTP ${status}`);
    this.name = "JupiterHttpError";
    this.status = status;
    this.path = path;
    this.retryAfterMs = retryAfterMs;
    this.bodyError = bodyError;
  }
}

export class JupiterUnavailableError extends Error {
  readonly code = JUPITER_UNAVAILABLE_CODE;
  constructor(cause?: unknown) {
    super(JUPITER_UNAVAILABLE_MESSAGE);
    this.name = "JupiterUnavailableError";
    if (cause !== undefined) this.cause = cause;
  }
}

export function retryAfterFromJupiterHeaders(headers: Headers, now = Date.now()): number | null {
  const retryAfter = parseRetryAfter(headers.get("retry-after"), now);
  if (retryAfter !== null) return retryAfter;
  const reset = headers.get("x-ratelimit-reset");
  if (!reset) return null;
  const unix = Number(reset);
  if (!Number.isFinite(unix)) return null;
  return Math.max(0, Math.ceil(unix * 1000 - now));
}

export function classifyJupiterError(error: unknown): JupiterErrorKind {
  if (error instanceof JupiterHttpError) {
    if (error.status === 429) return "rate-limit";
    if (error.status >= 500) return "http-5xx";
    if (error.status >= 400) return "http-4xx";
  }
  if (isTimeoutError(error)) return "timeout";
  const message = error instanceof Error ? error.message : String(error);
  if (/\b429\b|too many requests|rate[- ]?limit/i.test(message)) return "rate-limit";
  if (/\b5\d\d\b/.test(message)) return "http-5xx";
  if (/\b4\d\d\b/.test(message)) return "http-4xx";
  return "other";
}

export function isRetryableJupiterKind(kind: JupiterErrorKind): boolean {
  return kind === "rate-limit" || kind === "http-5xx" || kind === "timeout";
}

export function looksLikeJupiterUpstream(text: string): boolean {
  if (!/jupiter/i.test(text)) return false;
  return /\b429\b|too many requests|rate[- ]?limit|\b5\d\d\b|timed? out|aborted due to timeout/i.test(text);
}

export function isJupiterUpstreamError(error: unknown): boolean {
  if (error instanceof JupiterUnavailableError) return true;
  if (error instanceof JupiterHttpError) return error.status === 429 || error.status >= 500;
  const text = error instanceof Error ? error.message : String(error);
  return looksLikeJupiterUpstream(text);
}

export function asJupiterUserError(error: unknown): Error {
  if (error instanceof JupiterUnavailableError) return error;
  if (isJupiterUpstreamError(error)) return new JupiterUnavailableError(error);
  return error instanceof Error ? error : new Error(String(error));
}
