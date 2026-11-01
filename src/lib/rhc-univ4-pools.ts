import "@/lib/engine-host";
import "server-only";

import { UNIV4_RHC_ALLOWLISTED_POOLS, type Univ4AllowlistedPool } from "@sofinance/engine/protocols/uniswap-v4/constants";
import { discoverUniv4RhcPools, type Univ4PoolSummary } from "@sofinance/engine/protocols/uniswap-v4/discovery";
import { ESTIMATED_APR_LABEL, fetchUniv4MarketData, type Univ4MarketData } from "@sofinance/engine/protocols/uniswap-v4/market-data";
import { createRhcClient } from "@sofinance/engine/rpc-evm/index";
import type { PublicClient } from "viem";
import { AsyncCache } from "./async-cache";

/**
 * Read-only Uniswap v4 pools on Robinhood Chain (chain 4663) for `/api/protocol-pools`.
 * Only the reviewed StablePairHook allowlist (11 RH↔Ondo pairs); each pool is re-checked from current
 * on-chain state on every refresh and reported `delisted` if its hook implementation, fee config, key or
 * metadata no longer match. APR = hook fee rate × 24h volume / TVL from DexScreener (GeckoTerminal fallback):
 * no event scans over RPC (PM decision 2026-10-29). No transaction is built here.
 */
export type RhcUniv4PoolsResult = {
  protocol: "uniswap-v4-rhc";
  chainId: 4663;
  readOnly: true;
  pools: Univ4PoolSummary[];
  fetchedAt: string;
  source: string;
  aprLabel: { zh: "估計"; en: "Estimated" };
  aprNote: string;
  /** Present when served from the cron's saved snapshot (production): `stale` past the 26h rule. */
  snapshot?: { stale: boolean };
};

const LIVE_SOURCE = "Robinhood Chain RPC: StateView / StablePairHook (allowlist: 11 StablePairHook RH↔Ondo pairs); 24h volume and TVL: DexScreener (GeckoTerminal fallback)";
const SNAPSHOT_SOURCE = "Daily snapshot (cron): Robinhood Chain RPC StateView / StablePairHook checks; 24h volume and TVL: GeckoTerminal /pools/multi (DexScreener fallback)";

/** Response body for a list of pool summaries (live read or saved snapshot). */
export function rhcPoolsResult(pools: Univ4PoolSummary[], fetchedAt: string, snapshot?: { stale: boolean; snapshot: true }): RhcUniv4PoolsResult {
  return {
    protocol: "uniswap-v4-rhc",
    chainId: 4663,
    readOnly: true,
    pools,
    fetchedAt,
    source: snapshot ? SNAPSHOT_SOURCE : LIVE_SOURCE,
    aprLabel: ESTIMATED_APR_LABEL,
    aprNote: "Estimated (估計) pool fee APR = hook's current fee rate × 24h volume / TVL × 365 (USD, from public indexers). The StablePairHook fee is dynamic; an estimate, not a guarantee.",
    ...(snapshot ? { snapshot: { stale: snapshot.stale } } : {}),
  };
}

const STATE_TTL_MS = 60_000;
const FAILURE_TTL_MS = 15_000;
/** One DexScreener call per pool per 2 min per instance (documented limit: 300/min). */
const MARKET_TTL_MS = 120_000;
const MARKET_FAILURE_TTL_MS = 60_000;
/** GeckoTerminal keyless is ~5–10 calls/min per shared IP: after a 429 skip it for 5 min. */
const GECKO_COOLDOWN_MS = 5 * 60_000;

const cache = new AsyncCache<RhcUniv4PoolsResult>({ ttlMs: STATE_TTL_MS, failureTtlMs: FAILURE_TTL_MS, maxEntries: 1 });
const marketCache = new AsyncCache<Univ4MarketData | null>({ ttlMs: MARKET_TTL_MS, failureTtlMs: MARKET_FAILURE_TTL_MS, maxEntries: 16 });
/** Our own GeckoTerminal budget (below its ~5–10/min keyless limit): at most 4 fallback calls per rolling minute. */
const GECKO_MAX_CALLS_PER_MINUTE = 4;
let geckoBlockedUntil = 0;
let geckoCalls: number[] = [];

/** True (and the call is counted) when a GeckoTerminal fallback request fits the budget. */
export function takeGeckoTerminalSlot(now = Date.now()): boolean {
  if (now < geckoBlockedUntil) return false;
  geckoCalls = geckoCalls.filter(t => now - t < 60_000);
  if (geckoCalls.length >= GECKO_MAX_CALLS_PER_MINUTE) return false;
  geckoCalls.push(now);
  return true;
}
let stateClient: PublicClient | null = null;

function marketDataFor(fetcher?: typeof fetch) {
  return (spec: Univ4AllowlistedPool) => marketCache.get(spec.poolId.toLowerCase(), () => fetchUniv4MarketData(spec, {
    fetcher,
    allowFallback: () => takeGeckoTerminalSlot(),
    onUpstream: event => { if (event.source === "geckoterminal" && event.outcome === "rate-limited") geckoBlockedUntil = Date.now() + GECKO_COOLDOWN_MS; },
  }));
}

export async function discoverRhcUniv4Pools(options: {
  clients?: { state: PublicClient }; fetcher?: typeof fetch; bypassCache?: boolean;
  /** Override the allowlist (tests pass the SPCX-only fixture). */
  pools?: typeof UNIV4_RHC_ALLOWLISTED_POOLS;
} = {}): Promise<RhcUniv4PoolsResult> {
  const load = async (): Promise<RhcUniv4PoolsResult> => {
    const pools = await discoverUniv4RhcPools({
      clients: options.clients ?? { state: (stateClient ??= createRhcClient("state")) },
      marketData: marketDataFor(options.fetcher),
      ...(options.pools ? { pools: options.pools } : {}),
    });
    return rhcPoolsResult(pools, new Date().toISOString());
  };
  return options.bypassCache ? load() : cache.get("pools", load);
}

/** Test hook. */
export function resetRhcUniv4PoolsCache(): void {
  cache.clear();
  marketCache.clear();
  geckoBlockedUntil = 0;
  geckoCalls = [];
  stateClient = null;
}
