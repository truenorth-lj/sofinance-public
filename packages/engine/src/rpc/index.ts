import { engineEnv } from "../host";
import { Connection, type Commitment } from "@solana/web3.js";
import { resetRpcCache, setRpcCache } from "./cache";
import { resetRpcCircuit } from "./circuit";
import { createPooledConnection, createResilientConnection } from "./connection";
import { setRpcLogger } from "./logger";
import { resolveRpcPool, type RpcPoolMember } from "./pool";
import { resolveDefaultRpcConfig, resolveRpcConfig } from "./providers";
import { resetRpcRateLimiters } from "./rate-limit";
import { resetReadRotation } from "./select";
import { setRpcRetryConfig, type RetryConfig } from "./retry";
import type { RpcEnv } from "./types";

export type { RpcConfig, RpcEnv, RpcMetricId, RpcProvider, RpcProviderId, RpcCallMetric, RpcErrorKind, RpcFallbackReason, RpcLogEvent, RpcLogger, RpcRoute } from "./types";
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
export { classifyRpcError, isMinContextSlotError, MIN_CONTEXT_SLOT_RPC_CODE, isRpcStructValidationError, shouldFallback, RpcHttpError, RpcUnavailableError, RPC_UNAVAILABLE_MESSAGE, asRpcUserError } from "./errors";
export { DEFAULT_METHOD_POLICY, METHOD_POLICIES, jsonRpcMethodOf, methodAllowsFallback, policyFor, routeFor, cacheTtlFor, UNCACHEABLE_METHODS } from "./methods";
export { attemptFor, createPooledConnection, createResilientConnection, invokeAcrossProviders, invokeWithPolicy, lastRpcCallMetric } from "./connection";
export type { InvokeWithPolicyResult, PooledConnectionOptions, ProviderAttempt } from "./connection";
export { POOL_RATE_LIMIT_MAX_COOLDOWN_MS, PRIMARY_RPC_CONCURRENCY, RpcPoolConfigError, memberSupports, parseRpcProviders, resolveRpcPool, routeMembers } from "./pool";
export type { RpcPool, RpcPoolMember, RpcProviderEntry } from "./pool";
export { TokenBucket, rateLimiterFor, resetRpcRateLimiters } from "./rate-limit";
export { DEFAULT_READ_WEIGHT, readWeight, resetReadRotation, spreadsReads, weightedReadOrder } from "./select";
export { rpcRequest } from "./json-rpc";
export {
  estimateFeeForMessage,
  withFeeEstimateRetry,
  isEmptyFeeEstimate,
  isTransientFeeEstimateError,
  FEE_ESTIMATE_ATTEMPTS,
  FEE_ESTIMATE_BACKOFF_MS,
  FEE_ESTIMATE_TIMEOUT_MS,
  OPEN_FEE_ESTIMATE_MESSAGE,
  WITHDRAW_FEE_ESTIMATE_MESSAGE,
  COMPOUND_FEE_ESTIMATE_MESSAGE,
  RECOVERY_FEE_ESTIMATE_MESSAGE,
  CLEANUP_FEE_ESTIMATE_MESSAGE,
  FEE_ESTIMATE_TIMEOUT_MESSAGE,
} from "./fee-estimate";
export { MemoryRpcCache, getRpcCache, setRpcCache, resetRpcCache, cacheKeyFor } from "./cache";
export { setRpcLogger } from "./logger";
export { setRpcRetryConfig, computeBackoffMs, parseRetryAfter, invokeWithRetries, DEFAULT_RETRY, PREVIEW_RETRY, MIN_CONTEXT_SLOT_RETRY_MS } from "./retry";
export type { RetryConfig } from "./retry";
export { rpcLogEnabled, formatRpcLog, defaultRpcLogger } from "./logger";
export {
  DEFAULT_CIRCUIT,
  circuitErrorKind,
  isPrimaryCircuitOpen,
  notePrimaryFailure,
  notePrimarySuccess,
  resetRpcCircuit,
  rpcCircuitConfig,
  setRpcCircuitClock,
  setRpcCircuitConfig,
} from "./circuit";
export type { RpcCircuitConfig } from "./circuit";

export type RpcConnectionInit = {
  fetch?: typeof fetch;
  signal?: AbortSignal;
  commitment?: Commitment;
  env?: RpcEnv;
  retry?: Partial<RetryConfig> | null;
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
 * A Connection whose every call goes through the provider pool (see README "RPC provider pool").
 *
 * Without SOLANA_RPC_PROVIDERS: Solami when `SOLAMI_API_KEY` is set, else `SOLANA_RPC_URL`, else
 * public mainnet, with the next distinct endpoint as fallback — unchanged from engine 0.1.3.
 * Auth / rate-limit / 5xx / timeout fail over per `METHOD_POLICIES`; a short circuit-breaker skips a
 * dead provider until its cooldown elapses. Keys stay server-side and never reach logs.
 *
 * Create one per logical request: reads on it stick to one provider (pool mode).
 */
export function rpcConnection(env: RpcEnv = engineEnv() as RpcEnv, init: RpcConnectionInit = {}) {
  return pooledConnection(init.env ?? env, init, false);
}

/**
 * Same as `rpcConnection`, for display reads that never simulate or send: slot-context reads
 * (`getMultipleAccountsInfoAndContext`, `getSlot`) may use the read providers too. Identical to
 * `rpcConnection` without SOLANA_RPC_PROVIDERS.
 */
export function rpcReadConnection(env: RpcEnv = engineEnv() as RpcEnv, init: RpcConnectionInit = {}) {
  return pooledConnection(init.env ?? env, init, true);
}

function pooledConnection(env: RpcEnv, init: RpcConnectionInit, readOnly: boolean) {
  const pool = resolveRpcPool(env);
  const connections = new Map<string, Connection>();
  const connectionFor = (member: RpcPoolMember) => {
    let connection = connections.get(member.endpoint);
    if (!connection) {
      connection = createEndpointConnection(member.endpoint, init);
      connections.set(member.endpoint, connection);
    }
    return connection;
  };
  return createPooledConnection(pool, connectionFor, { signal: init.signal, retry: init.retry, readOnly });
}

export function defaultRpcConnection(env: RpcEnv = engineEnv() as RpcEnv, init: RpcConnectionInit = {}) {
  return createResilientConnection(
    createEndpointConnection(resolveDefaultRpcConfig(init.env ?? env).endpoint, init),
    null,
    { primaryId: "default", fallbackId: "default", signal: init.signal, retry: init.retry },
  );
}

export function rpcConfig(env: RpcEnv = engineEnv() as RpcEnv) {
  return resolveRpcConfig(env);
}

/** Test helper: clear cache, inflight map, logger, retry overrides, and circuit. */
export function resetRpcRuntime() {
  resetRpcCache();
  setRpcCache(null);
  setRpcLogger(null);
  setRpcRetryConfig(null);
  resetRpcCircuit();
  resetRpcRateLimiters();
  resetReadRotation();
}
