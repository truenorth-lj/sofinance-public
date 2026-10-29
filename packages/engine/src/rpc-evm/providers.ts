import { ROBINHOOD_PUBLIC_RPC_URL } from "../chains/robinhood";

/**
 * Robinhood Chain (4663) JSON-RPC catalog. Read-only: the server never broadcasts EVM transactions.
 *
 * Two routes, because the free endpoints differ in what they serve (measured 2026-10-29):
 * - `state` (eth_call / multicall, eth_getStorageAt, eth_getBlockByNumber at `latest`):
 *   dRPC free → PublicNode → official public RPC (last, low local quota).
 * - `logs` (eth_getLogs over wide block ranges): dRPC's free plan rejects ranges over ~100 blocks and
 *   PublicNode treats any historical range as an archive request, so only the official RPC (or a
 *   dedicated key, if one is configured later) can serve them.
 *
 * `RHC_RPC_URL` is an optional host-injected slot for a dedicated provider (e.g. an Alchemy URL with
 * its key). It is not set anywhere today; when present it is tried first on both routes. URLs are
 * never logged or returned to clients: only the provider `id` is.
 */
export type EvmRpcProviderId = "dedicated" | "drpc" | "publicnode" | "official";
export type EvmRpcRoute = "state" | "logs";

export type EvmRpcProviderDefinition = {
  id: EvmRpcProviderId;
  label: string;
  routes: readonly EvmRpcRoute[];
  /** Local token bucket (process-local, per server instance), a little under the provider's limit. */
  rps: number;
  burst: number;
  endpoint: (env: Readonly<Record<string, string | undefined>>) => string | null;
};

export const DRPC_ROBINHOOD_URL = "https://robinhood.drpc.org";
export const PUBLICNODE_ROBINHOOD_URL = "https://robinhood-rpc.publicnode.com";

export const RHC_RPC_PROVIDERS: readonly EvmRpcProviderDefinition[] = Object.freeze([
  { id: "dedicated", label: "Dedicated RPC (RHC_RPC_URL)", routes: ["state", "logs"], rps: 10, burst: 20,
    endpoint: env => env.RHC_RPC_URL?.trim() || null },
  { id: "drpc", label: "dRPC (free)", routes: ["state"], rps: 4, burst: 8, endpoint: () => DRPC_ROBINHOOD_URL },
  { id: "publicnode", label: "PublicNode", routes: ["state"], rps: 4, burst: 8, endpoint: () => PUBLICNODE_ROBINHOOD_URL },
  // Official public RPC answers 429 after ~40 rapid calls: keep our own budget well below that.
  { id: "official", label: "Robinhood public RPC", routes: ["state", "logs"], rps: 0.5, burst: 6,
    endpoint: () => ROBINHOOD_PUBLIC_RPC_URL },
] satisfies EvmRpcProviderDefinition[]);

export type ResolvedEvmProvider = { id: EvmRpcProviderId; url: string; rps: number; burst: number };

/** Providers for one route in priority order (dedicated first when configured, official last). */
export function resolveEvmProviders(route: EvmRpcRoute, env: Readonly<Record<string, string | undefined>>): ResolvedEvmProvider[] {
  return RHC_RPC_PROVIDERS.flatMap(provider => {
    if (!provider.routes.includes(route)) return [];
    const url = provider.endpoint(env);
    return url ? [{ id: provider.id, url, rps: provider.rps, burst: provider.burst }] : [];
  });
}
