import "@/lib/engine-host";
import { APP_ROUTES, CANONICAL_SITE_URL, buildOpenPositionUrl } from "../../lib/public-urls";
import type { RwaPairRow } from "@/lib/rwa-pairs";
import type { ListRwaPairsInput } from "../schemas";
import { poolSnapshotEnabled, readListedPairs, readPoolApr } from "./pool-snapshot";
import { FEES_NOTE, RANGE_PRESETS, WINDOW_LABEL, protocolName, summarizePoolApr7d, type PoolApr7dSummary } from "./pool-apr";

/** Ticker match on either token symbol or the pair's base ticker ("TSLA" finds TSLA/TSLAx). */
function pairMatchesSymbol(pair: Pick<RwaPairRow, "symbolA" | "symbolB" | "baseSymbol">, symbol: string): boolean {
  const wanted = symbol.trim().toUpperCase();
  return [pair.baseSymbol, pair.symbolA, pair.symbolB].some((value) => value?.toUpperCase() === wanted);
}

const NO_STORE_APR: PoolApr7dSummary = {
  status: "unavailable",
  reason: "7-day estimates come from the hosted pools snapshot. Call get_pool_range_apr for one pool.",
};

export const APR_24H_WARNING =
  "No 7-day estimate for this pool. estimatedFeeAprPct is a 24-hour figure (last 24h fees / current TVL, annualized), not a 7-day estimate; on a small or new pool it can swing far from what a position would collect.";

function apr7dWarning(summary: PoolApr7dSummary | undefined): { warning?: string } {
  return summary?.status === "ready" ? {} : { warning: APR_24H_WARNING };
}

async function apr7dFor(pairs: RwaPairRow[]): Promise<Map<string, PoolApr7dSummary>> {
  const out = new Map<string, PoolApr7dSummary>();
  if (!poolSnapshotEnabled()) {
    // Self-hosted without the store: one live estimate per pool would mean many RPC reads; leave it per pool.
    for (const pair of pairs) out.set(pair.poolAddress, NO_STORE_APR);
    return out;
  }
  const now = Date.now();
  const results = await Promise.allSettled(pairs.map((pair) => readPoolApr(pair.poolAddress)));
  results.forEach((result, index) => {
    const pair = pairs[index]!;
    out.set(pair.poolAddress, result.status === "fulfilled"
      ? summarizePoolApr7d(result.value, pair.protocol, now)
      : { status: "unavailable", reason: "No 7-day estimate right now." });
  });
  return out;
}

const SORTERS: Record<ListRwaPairsInput["sortBy"], (pair: RwaPairRow, apr?: PoolApr7dSummary) => number | null> = {
  apr7d: (_pair, apr) => (apr?.status === "ready" ? apr.highestRangeAprPct : null),
  estimatedFeeApr: (pair) => pair.estimatedFeeAprPct,
  tvl: (pair) => pair.tvlUsd,
  volume24h: (pair) => pair.volume24hUsd,
};

/**
 * Listed same-stock Solana pools (Raydium CLMM and Meteora DLMM) from the saved pools snapshot, the same list as
 * https://sofinancelab.xyz/app/rwa-pairs, each with its 7-day range APR summary.
 *
 * Safety: read-only. Production reads saved snapshots only (no RPC); no wallet or token needed.
 */
export async function listRwaPairs(input: ListRwaPairsInput) {
  const listed = await readListedPairs();
  const pairs = listed.pairs
    .filter((pair) => (pair.tvlUsd ?? 0) >= input.minTvl)
    .filter((pair) => !input.symbol || pairMatchesSymbol(pair, input.symbol));
  const apr = await apr7dFor(pairs);
  const key = SORTERS[input.sortBy];
  const sorted = [...pairs].sort((a, b) => {
    const left = key(a, apr.get(a.poolAddress));
    const right = key(b, apr.get(b.poolAddress));
    if (left === null && right === null) return (b.tvlUsd ?? 0) - (a.tvlUsd ?? 0);
    if (left === null) return 1;
    if (right === null) return -1;
    return right - left || (b.tvlUsd ?? 0) - (a.tvlUsd ?? 0);
  });

  return {
    source: listed.snapshot ? "SoFinance saved pools snapshot (same list as the pools page)" : listed.source,
    snapshotAt: listed.fetchedAt,
    stale: listed.stale,
    pairingRule: listed.pairingRule,
    aprWindow: WINDOW_LABEL,
    note: FEES_NOTE,
    poolsPage: `${CANONICAL_SITE_URL}${APP_ROUTES.rwaPairs}`,
    rangePresets: RANGE_PRESETS,
    count: sorted.length,
    pairs: sorted.map((pair) => ({
      poolAddress: pair.poolAddress,
      chain: "solana",
      protocol: pair.protocol,
      protocolName: protocolName(pair.protocol),
      mintA: pair.mintA,
      mintB: pair.mintB,
      symbolA: pair.symbolA,
      symbolB: pair.symbolB,
      nameA: pair.nameA,
      nameB: pair.nameB,
      baseSymbol: pair.baseSymbol,
      wrapKind: pair.wrapKind,
      feeTierBps: pair.feeTierBps,
      ...(pair.binStep === undefined ? {} : { binStep: pair.binStep }),
      tvlUsd: pair.tvlUsd,
      volume24hUsd: pair.volume24hUsd,
      fees24hUsd: pair.fees24hUsd,
      apr7d: apr.get(pair.poolAddress) ?? NO_STORE_APR,
      // Pool-level 24h figure kept for older clients; apr7d is the estimate the site shows.
      estimatedFeeAprPct: pair.estimatedFeeAprPct,
      estimatedFeeAprLabel: pair.estimatedFeeAprLabel,
      estimatedFeeAprWindow: "24h" as const,
      ...apr7dWarning(apr.get(pair.poolAddress)),
      token2022A: pair.token2022A,
      token2022B: pair.token2022B,
      freezeRisk: pair.freezeRisk,
      openPositionUrl: buildOpenPositionUrl(pair.poolAddress),
    })),
  };
}
