import { engineEnv } from "../host";
import type { RpcLogEvent, RpcLogger } from "./types";

export function rpcLogEnabled(env: Record<string, string | undefined> = engineEnv()): boolean {
  const flag = env.SOFINANCE_RPC_LOG?.trim().toLowerCase();
  return flag === "1" || flag === "true" || flag === "on";
}

/** Structured, key-free line for Vercel / server logs. Never includes URLs or keys. */
export function formatRpcLog(event: RpcLogEvent): string {
  return JSON.stringify({
    rpc: true,
    method: event.method,
    provider: event.provider,
    ...(event.via ? { via: event.via } : {}),
    outcome: event.outcome,
    status: event.errorKind ?? (event.outcome === "ok" || event.outcome === "cache-hit" ? "ok" : event.outcome),
    retries: event.retries ?? 0,
    cacheHit: event.cacheHit === true,
    ...(event.attempt !== undefined ? { attempt: event.attempt } : {}),
    ...(event.reason ? { reason: event.reason } : {}),
  });
}

export function defaultRpcLogger(event: RpcLogEvent): void {
  // Fallback / circuit-open is always-on so a lapsed primary is visible in
  // production logs without SOFINANCE_RPC_LOG. Lines are key- and URL-free.
  if (event.outcome === "fallback") {
    // eslint-disable-next-line no-console -- never includes keys/URLs
    console.warn(formatRpcLog(event));
    return;
  }
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
