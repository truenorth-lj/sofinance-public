import { engineEnv } from "../host";
import { PUBLIC_SOLANA_RPC_URL, isRetiredRpcEndpoint } from "./urls";
import type { ProviderPair, ResolvedProvider, RpcConfig, RpcEnv, RpcMetricId, RpcProviderId } from "./types";

export { PUBLIC_SOLANA_RPC_URL, RETIRED_RPC_HOSTS, isRetiredRpcEndpoint } from "./urls";

export type RpcProviderDefinition = {
  id: RpcProviderId;
  metricId: RpcMetricId;
  label: string;
  endpoint: (env: RpcEnv) => string | null;
};

/**
 * Catalog of JSON-RPC endpoints. Order is selection priority when an endpoint
 * is configured. Adding a provider is a new entry here — not a new if-chain
 * in callers.
 */
export const RPC_PROVIDERS: readonly RpcProviderDefinition[] = [
  {
    id: "generic",
    metricId: "default",
    label: "Dedicated RPC",
    endpoint: (env) => env.SOLANA_RPC_URL?.trim() || null,
  },
  {
    id: "public",
    metricId: "default",
    label: "Public Solana RPC",
    endpoint: () => PUBLIC_SOLANA_RPC_URL,
  },
];

function resolveDefinition(def: RpcProviderDefinition, env: RpcEnv): ResolvedProvider | null {
  const endpoint = def.endpoint(env);
  if (!endpoint) return null;
  // A SOLANA_RPC_URL on a retired vendor host is skipped like an unset key.
  if (isRetiredRpcEndpoint(endpoint)) return null;
  return {
    id: def.id,
    metricId: def.metricId,
    label: def.label,
    endpoint,
  };
}

export function resolveProvider(id: RpcProviderId, env: RpcEnv = engineEnv() as RpcEnv): ResolvedProvider | null {
  const def = RPC_PROVIDERS.find((item) => item.id === id);
  return def ? resolveDefinition(def, env) : null;
}

/**
 * Primary is the first configured catalog entry (generic → public).
 * Fallback is the next distinct endpoint — used only when the method policy
 * allows it.
 */
export function resolveProviderPair(env: RpcEnv = engineEnv() as RpcEnv): ProviderPair {
  const resolved = RPC_PROVIDERS
    .map((def) => resolveDefinition(def, env))
    .filter((item): item is ResolvedProvider => item !== null);
  const primary = resolved[0];
  if (!primary) {
    const pub = resolveDefinition(RPC_PROVIDERS[RPC_PROVIDERS.length - 1]!, env)!;
    return { primary: pub, fallback: null };
  }
  const fallback = resolved.find((item) => item.endpoint !== primary.endpoint) ?? null;
  return { primary, fallback };
}

export function resolveRpcConfig(env: RpcEnv = engineEnv() as RpcEnv): RpcConfig {
  const { primary } = resolveProviderPair(env);
  return { endpoint: primary.endpoint, provider: primary.metricId };
}

export function resolveDefaultRpcConfig(env: RpcEnv = engineEnv() as RpcEnv): RpcConfig {
  const generic = resolveProvider("generic", env);
  if (generic) return { endpoint: generic.endpoint, provider: "default" };
  const pub = resolveProvider("public", env)!;
  return { endpoint: pub.endpoint, provider: "default" };
}

export function rpcProvider(env: RpcEnv = engineEnv() as RpcEnv): RpcMetricId {
  return resolveRpcConfig(env).provider;
}

/** Strip credential query params so an endpoint can be mentioned in errors. */
export function redactRpcEndpoint(endpoint: string): string {
  try {
    const url = new URL(endpoint);
    if (url.searchParams.has("api_key")) url.searchParams.set("api_key", "REDACTED");
    return `${url.origin}${url.pathname}`;
  } catch {
    return "rpc";
  }
}
