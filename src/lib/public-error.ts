import "@/lib/engine-host";
import {
  isJupiterUpstreamError,
  JUPITER_NO_ROUTE_CODE,
  JUPITER_UNAVAILABLE_CODE,
  JUPITER_UNAVAILABLE_MESSAGE,
  JupiterHttpError,
  JupiterUnavailableError,
  RPC_UNAVAILABLE_CODE,
} from "@sofinance/engine/jupiter/errors";
import { isJupiterNoRouteError, JupiterNoRouteError } from "@sofinance/engine/swap/jupiter";
import { RPC_UNAVAILABLE_MESSAGE } from "@sofinance/engine/rpc/errors";
import { formatSelectedNoRouteMessage, SelectedNoRouteError } from "./selected-no-route";
import {
  AMOUNT_TOO_SMALL_CODE,
  AMOUNT_TOO_SMALL_MESSAGE,
  isAmountTooSmallError,
  JUPITER_CLIENT_ERROR_CODE,
  jupiterClientErrorMessage,
} from "./selected-amount-error";

const PUBLIC_ERROR_LIMIT = 220;
const SECRET = /https?:\/\/\S+|\b(?:api[_-]?key|authorization|token)\s*[:=]\s*\S+/gi;

/** Prepare/quote rejected a size that would walk the pool through a tick where liquidity changes. */
export const CROSS_TICK_USER_MESSAGE =
  "This amount is large for this pool's current depth. Try a smaller amount, a wider range, or refresh the quote.";

export class ApiRequestError extends Error {
  readonly sent?: boolean;
  constructor(message: string, sent?: boolean) {
    super(message);
    this.name = "ApiRequestError";
    if (sent === false) this.sent = false;
  }
}

export class CompoundSendError extends Error {
  readonly sent?: boolean;
  constructor(cause: unknown, sent?: boolean) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "CompoundSendError";
    this.cause = cause;
    if (sent === false) this.sent = false;
  }
}

export function errorText(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) {
    const logs = "logs" in error && Array.isArray(error.logs)
      ? error.logs.filter((item): item is string => typeof item === "string").slice(-8).join(" | ") : "";
    const transactionError = "transactionError" in error && error.transactionError !== undefined
      ? JSON.stringify(error.transactionError) : "";
    return [error.message, transactionError, logs].filter(Boolean).join(" ");
  }
  try { return JSON.stringify(error); } catch { return String(error); }
}

export function mapKnownChainError(text: string): string | null {
  if (/tick-spacing boundary|cross-tick depth|cross position boundary|cross the selected range/i.test(text)) {
    return CROSS_TICK_USER_MESSAGE;
  }
  if (looksLikeJupiterPublicError(text)) return JUPITER_UNAVAILABLE_MESSAGE;
  if (/429|too many requests|rate[- ]?limit/i.test(text)) return RPC_UNAVAILABLE_MESSAGE;
  if (/6017|0x1781|price\s*slippage/i.test(text)) return "Pool price moved past the add-liquidity cap (Raydium 6017).";
  if (/insufficient funds|insufficient lamports|custom program error:\s*0x1\b/i.test(text)) {
    return "Insufficient tokens or SOL after swap slippage or fees.";
  }
  if (/blockhash not found|blockhash expired|transaction has expired|blockhashNotFound/i.test(text)) {
    return "Transaction blockhash expired.";
  }
  if (/already in use|already exist/i.test(text)) return "Yield accounts already exist; please reprepare.";
  if (/account not found/i.test(text)) return "Required account was not found on-chain.";
  if (/custom program error:\s*0x1785|Custom":6021\b/i.test(text)) return "Raydium rejected the liquidity change.";
  return null;
}

export function isPreflightOrUnsentFailure(error: unknown): boolean {
  const text = errorText(error);
  if (/simulation failed|preflight|not sent|blockhash not found|blockhash expired/i.test(text)) return true;
  const mapped = mapKnownChainError(text);
  if (mapped === null || mapped === JUPITER_UNAVAILABLE_MESSAGE) return false;
  return true;
}

function sanitizeDetail(text: string) {
  return text.replace(SECRET, "[redacted]").replace(/\s+/g, " ").trim();
}

function truncate(text: string, limit = PUBLIC_ERROR_LIMIT) {
  return text.length <= limit ? text : `${text.slice(0, limit - 3)}...`;
}

function looksLikeJupiterPublicError(text: string): boolean {
  return isJupiterUpstreamError(new Error(text));
}

export function publicErrorCode(error: unknown): string | undefined {
  if (error instanceof SelectedNoRouteError || error instanceof JupiterNoRouteError || isJupiterNoRouteError(error)) {
    return JUPITER_NO_ROUTE_CODE;
  }
  if (isAmountTooSmallError(error)) return AMOUNT_TOO_SMALL_CODE;
  if (error instanceof JupiterHttpError && error.status === 400) return JUPITER_CLIENT_ERROR_CODE;
  if (error instanceof JupiterUnavailableError || isJupiterUpstreamError(error)) {
    return JUPITER_UNAVAILABLE_CODE;
  }
  const mapped = mapKnownChainError(errorText(error));
  if (mapped === JUPITER_UNAVAILABLE_MESSAGE) return JUPITER_UNAVAILABLE_CODE;
  if (mapped === RPC_UNAVAILABLE_MESSAGE) return RPC_UNAVAILABLE_CODE;
  return undefined;
}

/** Short, client-safe reason. Never includes RPC URLs or API keys. */
export function sanitizePublicError(error: unknown, fallback: string): string {
  if (error instanceof SelectedNoRouteError) return error.message;
  if (error instanceof JupiterNoRouteError || isJupiterNoRouteError(error)) {
    return formatSelectedNoRouteMessage("this input asset", "the pool tokens");
  }
  if (isAmountTooSmallError(error)) return AMOUNT_TOO_SMALL_MESSAGE;
  if (error instanceof JupiterHttpError && error.status === 400) {
    return truncate(sanitizeDetail(jupiterClientErrorMessage(error)));
  }
  if (error instanceof JupiterUnavailableError || isJupiterUpstreamError(error)) {
    return JUPITER_UNAVAILABLE_MESSAGE;
  }
  const raw = errorText(error);
  const mapped = mapKnownChainError(raw);
  if (mapped === CROSS_TICK_USER_MESSAGE) {
    // Technical engine text stays in logs; the client sees the short action.
    // eslint-disable-next-line no-console
    console.info("cross-tick", sanitizeDetail(raw).slice(0, 300));
    return mapped;
  }
  if (mapped === RPC_UNAVAILABLE_MESSAGE || mapped === JUPITER_UNAVAILABLE_MESSAGE) return mapped;
  const detail = sanitizeDetail(raw);
  if (mapped && detail) {
    const combined = detail.toLowerCase().includes(mapped.toLowerCase().slice(0, 24)) ? mapped : `${mapped} ${detail}`;
    return truncate(combined);
  }
  if (mapped) return mapped;
  if (detail) return truncate(detail);
  return fallback;
}

export function notSentRetryMessage(reason: string) {
  if (/not sent/i.test(reason) && /safe to retry/i.test(reason)) return reason;
  if (/not sent/i.test(reason)) return `${reason} Safe to retry.`;
  return `${reason} Transaction was not sent, safe to retry.`;
}

export function resolveCompoundBroadcastFailure(input: { persisted: boolean; sent?: boolean; message: string }) {
  if (input.persisted && input.sent === false) {
    return { abandon: true, keepPending: false, error: notSentRetryMessage(input.message) };
  }
  if (input.persisted) return { abandon: false, keepPending: true, error: "" };
  return { abandon: false, keepPending: false, error: input.message };
}
