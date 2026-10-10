import "server-only";

import { Connection } from "@solana/web3.js";
import { createResilientConnection } from "./connection";
import { resolveDefaultRpcConfig, resolveProviderPair, resolveRpcConfig } from "./providers";
import type { RpcEnv } from "./types";

export type { RpcConfig, RpcEnv, RpcMetricId, RpcProvider, RpcProviderId, RpcCallMetric, RpcErrorKind } from "./types";
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
export { classifyRpcError, isRpcStructValidationError, shouldFallback } from "./errors";
export { DEFAULT_METHOD_POLICY, METHOD_POLICIES, methodAllowsFallback, policyFor } from "./methods";
export { createResilientConnection, invokeWithPolicy, lastRpcCallMetric } from "./connection";

/**
 * Prefer Solami when `SOLAMI_API_KEY` is set, else `SOLANA_RPC_URL`, else
 * public mainnet. Keys stay server-side. When Solami is primary, web3.js
 * methods that it answers non-compliantly fall back per `METHOD_POLICIES`.
 * Sends never retry on another RPC.
 */
export function rpcConnection(env: RpcEnv = process.env as RpcEnv) {
  const pair = resolveProviderPair(env);
  const primary = new Connection(pair.primary.endpoint, "confirmed");
  if (!pair.fallback) return primary;
  return createResilientConnection(primary, new Connection(pair.fallback.endpoint, "confirmed"), {
    primaryId: pair.primary.metricId,
    fallbackId: pair.fallback.metricId,
  });
}

export function defaultRpcConnection(env: RpcEnv = process.env as RpcEnv) {
  return new Connection(resolveDefaultRpcConfig(env).endpoint, "confirmed");
}

export function rpcConfig(env: RpcEnv = process.env as RpcEnv) {
  return resolveRpcConfig(env);
}
