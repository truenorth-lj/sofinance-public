import type { RpcLogEvent, RpcLogger } from "./types";

export function rpcLogEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const flag = env.SOFINANCE_RPC_LOG?.trim().toLowerCase();
  return flag === "1" || flag === "true" || flag === "on";
}

/** Structured, key-free line for Vercel / server logs. */
export function formatRpcLog(event: RpcLogEvent): string {
  return JSON.stringify({
    rpc: true,
    method: event.method,
    provider: event.provider,
    outcome: event.outcome,
    status: event.errorKind ?? (event.outcome === "ok" || event.outcome === "cache-hit" ? "ok" : event.outcome),
    retries: event.retries ?? 0,
    cacheHit: event.cacheHit === true,
    ...(event.attempt !== undefined ? { attempt: event.attempt } : {}),
  });
}

export function defaultRpcLogger(event: RpcLogEvent): void {
  if (!rpcLogEnabled()) return;
  // eslint-disable-next-line no-console -- opt-in via SOFINANCE_RPC_LOG, never includes keys/URLs
  console.info(formatRpcLog(event));
}

let logger: RpcLogger = defaultRpcLogger;

export function setRpcLogger(next: RpcLogger | null): void {
  logger = next ?? defaultRpcLogger;
}

export function emitRpcLog(...args: Parameters<RpcLogger>): void {
  logger(...args);
}
