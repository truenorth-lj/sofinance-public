import "server-only";

import { Connection, type Commitment } from "@solana/web3.js";
import { resetRpcCache, setRpcCache } from "./cache";
import { createResilientConnection } from "./connection";
import { setRpcLogger } from "./logger";
import { resolveDefaultRpcConfig, resolveProviderPair, resolveRpcConfig } from "./providers";
import { setRpcRetryConfig } from "./retry";
import type { RpcEnv } from "./types";

export type { RpcConfig, RpcEnv, RpcMetricId, RpcProvider, RpcProviderId, RpcCallMetric, RpcErrorKind, RpcLogEvent, RpcLogger } from "./types";
export type { RpcCacheStore } from "./cache";
export {
  PUBLIC_SOLANA_RPC_URL,
  RPC_PROVIDERS,
  SOLAMI_RPC_BASE_URL,
  providerSupportsCustomMethod,
  redactRpcEndpoint,
  resolveDefaultRpcConfig,
  resolveProvider,
  resolveProviderPair,
  resolveRpcConfig,
  rpcProvider,
} from "./providers";
export { classifyRpcError, isRpcStructValidationError, shouldFallback, RpcHttpError, RpcUnavailableError, RPC_UNAVAILABLE_MESSAGE, asRpcUserError } from "./errors";
export { DEFAULT_METHOD_POLICY, METHOD_POLICIES, methodAllowsFallback, policyFor, cacheTtlFor, UNCACHEABLE_METHODS } from "./methods";
export { createResilientConnection, invokeWithPolicy, lastRpcCallMetric } from "./connection";
export { rpcRequest } from "./json-rpc";
export { MemoryRpcCache, getRpcCache, setRpcCache, resetRpcCache, cacheKeyFor } from "./cache";
export { setRpcLogger } from "./logger";
export { setRpcRetryConfig, computeBackoffMs, parseRetryAfter, invokeWithRetries } from "./retry";

export type RpcConnectionInit = {
  fetch?: typeof fetch;
  signal?: AbortSignal;
  commitment?: Commitment;
  env?: RpcEnv;
};

function mergeSignals(left?: AbortSignal | null, right?: AbortSignal | null): AbortSignal | undefined {
  const first = left ?? undefined;
  const second = right ?? undefined;
  if (first && second) return AbortSignal.any([first, second]);
  return first ?? second;
}

function createEndpointConnection(endpoint: string, init: RpcConnectionInit = {}): Connection {
  const fetchImpl = init.fetch || init.signal
    ? (url: RequestInfo | URL, fetchInit?: RequestInit) => {
        const signal = mergeSignals(init.signal, fetchInit?.signal);
        return (init.fetch ?? fetch)(url, { ...fetchInit, signal });
      }
    : undefined;
  return new Connection(endpoint, {
    commitment: init.commitment ?? "confirmed",
    disableRetryOnRateLimit: true,
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  });
}

/**
 * Prefer Solami when `SOLAMI_API_KEY` is set, else `SOLANA_RPC_URL`, else
 * public mainnet. Keys stay server-side. When Solami is primary, web3.js
 * methods that it answers non-compliantly fall back per `METHOD_POLICIES`.
 * Sends never retry on another RPC. 429 / 5xx / timeout retry on the same
 * provider with jittered backoff before failover.
 */
export function rpcConnection(env: RpcEnv = process.env as RpcEnv, init: RpcConnectionInit = {}) {
  const resolved = init.env ?? env;
  const pair = resolveProviderPair(resolved);
  const primary = createEndpointConnection(pair.primary.endpoint, init);
  const fallback = pair.fallback ? createEndpointConnection(pair.fallback.endpoint, init) : null;
  return createResilientConnection(primary, fallback, {
    primaryId: pair.primary.metricId,
    fallbackId: pair.fallback?.metricId ?? "default",
    signal: init.signal,
  });
}

export function defaultRpcConnection(env: RpcEnv = process.env as RpcEnv, init: RpcConnectionInit = {}) {
  return createResilientConnection(
    createEndpointConnection(resolveDefaultRpcConfig(init.env ?? env).endpoint, init),
    null,
    { primaryId: "default", fallbackId: "default", signal: init.signal },
  );
}

export function rpcConfig(env: RpcEnv = process.env as RpcEnv) {
  return resolveRpcConfig(env);
}

/** Test helper: clear cache, inflight map, logger, and retry overrides. */
export function resetRpcRuntime() {
  resetRpcCache();
  setRpcCache(null);
  setRpcLogger(null);
  setRpcRetryConfig(null);
}
