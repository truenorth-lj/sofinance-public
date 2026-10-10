import type { RpcErrorKind } from "./types";

const STRUCT_VALIDATION = /At path:|Expected a .+ but received|Expected the value to satisfy a union/i;
const HTTP_STATUS = /\b([4-5]\d\d)\b/;

export function isRpcStructValidationError(error: unknown): boolean {
  return classifyRpcError(error) === "validation";
}

/**
 * Classify a thrown RPC / web3.js failure. 429 is `http-4xx` (rate limit);
 * Superstruct shape mismatches are `validation` (Solami non-compliance).
 */
export function classifyRpcError(error: unknown): RpcErrorKind {
  const message = error instanceof Error ? error.message : String(error);
  if (STRUCT_VALIDATION.test(message)) return "validation";
  const http = message.match(HTTP_STATUS);
  if (http) return http[1]!.startsWith("4") ? "http-4xx" : "http-5xx";
  if (/\bempty\b|no (?:result|transactions)\b/i.test(message)) return "empty";
  return "other";
}

export function shouldFallback(kind: RpcErrorKind, fallbackOn: readonly RpcErrorKind[]): boolean {
  return fallbackOn.includes(kind);
}
