import { RPC_UNAVAILABLE_MESSAGE } from "./rpc/errors";

const PUBLIC_ERROR_LIMIT = 220;
const SECRET = /https?:\/\/\S+|\b(?:api[_-]?key|authorization|token)\s*[:=]\s*\S+/gi;

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
  return /simulation failed|preflight|not sent|blockhash not found|blockhash expired/i.test(text)
    || mapKnownChainError(text) !== null;
}

function sanitizeDetail(text: string) {
  return text.replace(SECRET, "[redacted]").replace(/\s+/g, " ").trim();
}

function truncate(text: string, limit = PUBLIC_ERROR_LIMIT) {
  return text.length <= limit ? text : `${text.slice(0, limit - 3)}...`;
}

/** Short, client-safe reason. Never includes RPC URLs or API keys. */
export function sanitizePublicError(error: unknown, fallback: string): string {
  const raw = errorText(error);
  const mapped = mapKnownChainError(raw);
  if (mapped === RPC_UNAVAILABLE_MESSAGE) return mapped;
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
