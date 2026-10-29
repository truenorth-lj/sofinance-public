import "@/lib/engine-host";
import "server-only";

import { discoverUniv4RhcPools, type RawPoolHistory, type Univ4PoolSummary } from "@sofinance/engine/protocols/uniswap-v4/discovery";
import { createRhcClients, type RhcClients } from "@sofinance/engine/rpc-evm/index";
import type { Hex } from "viem";
import { AsyncCache } from "./async-cache";

/**
 * Read-only Uniswap v4 pools on Robinhood Chain (chain 4663) for `/api/protocol-pools`.
 * Only the reviewed allowlist (SPCX/SPCXon on the StablePairHook); each pool is re-checked on
 * every refresh and reported `delisted` if its hook implementation, fee config, key or metadata
 * no longer match. No transaction is built here (PR1 of the Robinhood Chain plan).
 */
export type RhcUniv4PoolsResult = {
  protocol: "uniswap-v4-rhc";
  chainId: 4663;
  readOnly: true;
  pools: Univ4PoolSummary[];
  fetchedAt: string;
  source: string;
  aprNote: string;
};

const STATE_TTL_MS = 60_000;
const FAILURE_TTL_MS = 15_000;
const cache = new AsyncCache<RhcUniv4PoolsResult>({ ttlMs: STATE_TTL_MS, failureTtlMs: FAILURE_TTL_MS, maxEntries: 1 });
// Incremental log cursor per pool (per server instance; a cold start rescans from pool init,
// 4 eth_getLogs calls on the official RPC).
const history = new Map<Hex, RawPoolHistory>();
let clients: RhcClients | null = null;

export async function discoverRhcUniv4Pools(options: { clients?: RhcClients; bypassCache?: boolean } = {}): Promise<RhcUniv4PoolsResult> {
  const load = async (): Promise<RhcUniv4PoolsResult> => {
    const pools = await discoverUniv4RhcPools({ clients: options.clients ?? (clients ??= createRhcClients()), history });
    return {
      protocol: "uniswap-v4-rhc",
      chainId: 4663,
      readOnly: true,
      pools,
      fetchedAt: new Date().toISOString(),
      source: "Robinhood Chain RPC: StateView / StablePairHook / PoolManager logs (allowlist: SPCX/SPCXon)",
      aprNote: "Estimates in token0 units from this pool's own swaps (24h / 7d) and liquidity; no USD prices, not a guarantee.",
    };
  };
  return options.bypassCache ? load() : cache.get("pools", load);
}

/** Test hook. */
export function resetRhcUniv4PoolsCache(): void {
  cache.clear();
  history.clear();
  clients = null;
}
