import "server-only";

import { fetchOrcaPools, type FetchOrcaPoolsOptions, type OrcaPoolSummary } from "@sofinance/engine/protocols/orca/discovery";
import { estimateFeeAprPct, FEE_APR_ESTIMATE_LABEL, hasFreezeTag, isToken2022Program } from "./rwa-pairing";
import type { RwaPairRow } from "./rwa-pairs";

/** Read-only Orca rows in the `/api/rwa-pairs` row shape (protocol "orca-whirlpool"). */
export function orcaPairRow(pool: OrcaPoolSummary): RwaPairRow {
  const { spec } = pool;
  // Display order follows the allowlist (wrapped first), like Raydium allowlisted pools.
  const freezeRiskA = hasFreezeTag(pool.tagsA), freezeRiskB = hasFreezeTag(pool.tagsB);
  return {
    poolAddress: pool.poolAddress,
    protocol: "orca-whirlpool",
    mintA: pool.mintA,
    mintB: pool.mintB,
    symbolA: pool.symbolA || (pool.mintA === spec.mintA ? spec.wrappedSymbol : spec.plainSymbol),
    symbolB: pool.symbolB || (pool.mintB === spec.mintB ? spec.plainSymbol : spec.wrappedSymbol),
    nameA: pool.nameA,
    nameB: pool.nameB,
    baseSymbol: spec.baseSymbol,
    wrappedSymbol: spec.wrappedSymbol,
    plainSymbol: spec.plainSymbol,
    wrapKind: "same-asset",
    relatedness: "allowlisted",
    qualificationA: "allowlist",
    qualificationB: "allowlist",
    preferredTags: false,
    jupiterTagsA: [],
    jupiterTagsB: [],
    feeRate: pool.feeRate,
    feeTierBps: pool.feeTierBps,
    tvlUsd: pool.tvlUsd,
    volume24hUsd: pool.volume24hUsd,
    // LP share (Orca keeps protocolFeeRate of every swap fee).
    fees24hUsd: pool.lpFees24hUsd,
    raydiumFeeApr24h: null,
    estimatedFeeAprPct: pool.tvlUsd !== null && pool.lpFees24hUsd !== null ? estimateFeeAprPct(pool.lpFees24hUsd, pool.tvlUsd) : null,
    estimatedFeeAprLabel: FEE_APR_ESTIMATE_LABEL,
    token2022A: isToken2022Program(pool.programA),
    token2022B: isToken2022Program(pool.programB),
    freezeRiskA,
    freezeRiskB,
    freezeRisk: freezeRiskA || freezeRiskB,
  };
}

export type OrcaPairsResult = {
  protocol: "orca-whirlpool";
  readOnly: true;
  pairs: RwaPairRow[];
  fetchedAt: string;
  source: string;
};

const CACHE_TTL_MS = 60_000;
let cache: { at: number; result: OrcaPairsResult } | null = null;

export async function discoverOrcaPairs(options: FetchOrcaPoolsOptions & { bypassCache?: boolean } = {}): Promise<OrcaPairsResult> {
  if (!options.bypassCache && cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.result;
  const pools = await fetchOrcaPools(options);
  const result: OrcaPairsResult = {
    protocol: "orca-whirlpool",
    readOnly: true,
    pairs: pools.map(orcaPairRow),
    fetchedAt: new Date().toISOString(),
    source: "https://api.orca.so/v2/solana/pools/{address} (allowlist: cbBTC/WBTC)",
  };
  if (!options.bypassCache) cache = { at: Date.now(), result };
  return result;
}
