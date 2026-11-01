import "@/lib/engine-host";
import "server-only";

import { MAX_POSITION_VALUES, readPositionValues, type RhcPositionValueRow } from "@sofinance/engine/protocols/uniswap-v4/position-value";
import type { PublicClient } from "viem";
import { AsyncCache } from "./async-cache";
import { createScanClient } from "./rhc-position-scan";
import { rhcPoolTokenPricesUsd } from "./rhc-univ4-pools";

/**
 * Liquidity amounts and unclaimed fees of Robinhood Chain Uniswap v4 position NFTs (public data, by NFT id), plus
 * USD prices per token when a public indexer reports them, for the `/app` detail panel. RPC: the official public
 * endpoint through the scan client (same gate, spacing and 429 cooldown as the holdings scan; never `RHC_RPC_URL`),
 * two multicalls per uncached request. Read-only: nothing is simulated, built or signed.
 */
export type { RhcPositionValueRow };
export type RhcPositionValuesResult = { state: "values"; values: RhcPositionValueRow[]; checkedAt: number };

export const VALUES_TTL_MS = 30_000;
const cache = new AsyncCache<RhcPositionValuesResult>({ ttlMs: VALUES_TTL_MS, failureTtlMs: 10_000, maxEntries: 500 });
let client: PublicClient | null = null;

/** Parses `ids=1,2,3` (decimal NFT ids, deduplicated, at most `MAX_POSITION_VALUES`); null when malformed or empty. */
export function parsePositionIds(raw: string | null): bigint[] | null {
  const parts = (raw ?? "").split(",").map(s => s.trim()).filter(Boolean);
  if (!parts.length || parts.length > MAX_POSITION_VALUES || parts.some(p => !/^[0-9]{1,30}$/.test(p))) return null;
  return [...new Set(parts.map(p => BigInt(p).toString()))].map(BigInt);
}

export async function rhcPositionValues(ids: bigint[], deps: { client?: PublicClient; fetcher?: typeof fetch } = {}): Promise<RhcPositionValuesResult> {
  const key = ids.map(String).sort().join(",");
  return cache.get(key, async () => {
    const values = await readPositionValues(deps.client ?? (client ??= createScanClient()), ids);
    const prices = new Map<string, { token0: number; token1: number } | null>();
    for (const poolId of new Set(values.map(v => v.poolId))) prices.set(poolId, await rhcPoolTokenPricesUsd(poolId, deps.fetcher));
    return {
      state: "values",
      values: values.map(v => ({ ...v, priceUsd0: prices.get(v.poolId)?.token0 ?? null, priceUsd1: prices.get(v.poolId)?.token1 ?? null })),
      checkedAt: Date.now(),
    };
  });
}

/** Test hook. */
export function resetRhcPositionValuesCache(): void { cache.clear(); client = null; }
