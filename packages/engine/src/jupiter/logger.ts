import { engineEnv } from "../host";
import { rpcLogEnabled } from "../rpc/logger";
import { isJupiterUpstreamError, type JupiterErrorKind } from "./errors";

const SECRET = /https?:\/\/\S+|\b(?:api[_-]?key|authorization|token)\s*[:=]\s*\S+/gi;

export type JupiterLogEvent = {
  path: string;
  method: string;
  outcome: "ok" | "retry" | "cache-hit" | "error";
  status?: number;
  attempt?: number;
  retries?: number;
  cacheHit?: boolean;
  errorKind?: JupiterErrorKind;
  selected?: boolean;
  durationMs?: number;
  delayMs?: number;
  rateLimitCurrent?: number;
  rateLimitRemaining?: number;
  rateLimitReset?: number;
  /** Served from a client-supplied (browser) response; no server Jupiter call. */
  relayed?: boolean;
  /** Which path produced this quote: browser relay, server key, or server after a relayed 429/5xx. */
  quotePath?: "browser" | "server" | "server_fallback";
};

export type JupiterLogger = (event: JupiterLogEvent) => void;

export function jupiterLogEnabled(env: Record<string, string | undefined> = engineEnv()): boolean {
  const flag = env.SOFINANCE_JUPITER_LOG?.trim().toLowerCase();
  return flag === "1" || flag === "true" || flag === "on" || rpcLogEnabled(env);
}

export function formatJupiterLog(event: JupiterLogEvent): string {
  return JSON.stringify({
    jupiter: true,
    path: event.path,
    method: event.method,
    outcome: event.outcome,
    status: event.status ?? event.errorKind ?? (event.outcome === "ok" || event.outcome === "cache-hit" ? "ok" : event.outcome),
    retries: event.retries ?? 0,
    cacheHit: event.cacheHit === true,
    ...(event.attempt !== undefined ? { attempt: event.attempt } : {}),
    ...(event.selected ? { selected: true } : {}),
    ...(event.relayed ? { relayed: true } : {}),
    ...(event.quotePath ? { quotePath: event.quotePath } : {}),
    ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
    ...(event.delayMs !== undefined ? { delayMs: event.delayMs } : {}),
    ...(event.rateLimitCurrent !== undefined ? { rateLimitCurrent: event.rateLimitCurrent } : {}),
    ...(event.rateLimitRemaining !== undefined ? { rateLimitRemaining: event.rateLimitRemaining } : {}),
    ...(event.rateLimitReset !== undefined ? { rateLimitReset: event.rateLimitReset } : {}),
  });
}

export function defaultJupiterLogger(event: JupiterLogEvent): void {
  if (!event.selected && !jupiterLogEnabled()) return;
  // eslint-disable-next-line no-console -- selected diagnostics contain only path/status/timing/quota
  console.info(formatJupiterLog(event));
}

let logger: JupiterLogger = defaultJupiterLogger;

export function setJupiterLogger(next: JupiterLogger | null): void {
  logger = next ?? defaultJupiterLogger;
}

export function emitJupiterLog(...args: Parameters<JupiterLogger>): void {
  logger(...args);
}

function sanitizeLogText(text: string): string {
  return text.replace(SECRET, "[redacted]").replace(/\s+/g, " ").trim().slice(0, 220);
}

/** Always-on, key-free line for the exit-preview catch path. */
export function logExitPreviewFailure(error: unknown): void {
  const name = error instanceof Error ? error.name : typeof error;
  const raw = error instanceof Error ? error.message : String(error);
  const payload: Record<string, unknown> = {
    exitPreview: true,
    errorName: name,
    errorMessage: sanitizeLogText(raw),
    jupiter: isJupiterUpstreamError(error),
  };
  if (error instanceof Error && "status" in error && typeof error.status === "number") {
    payload.httpStatus = error.status;
  }
  if (error instanceof Error && "path" in error && typeof error.path === "string") {
    payload.path = error.path;
  }
  // eslint-disable-next-line no-console -- always-on diagnostic; never includes keys/URLs
  console.info(JSON.stringify(payload));
}
