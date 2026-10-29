import "server-only";

import { fetchMeteoraPools, type FetchMeteoraPoolsOptions, type MeteoraPoolSummary } from "@sofinance/engine/protocols/meteora/discovery";
import { estimateFeeAprPct, FEE_APR_ESTIMATE_LABEL, isToken2022Program } from "./rwa-pairing";
import type { RwaPairRow } from "./rwa-pairs";

/**
 * Read-only Meteora DLMM rows in the `/api/rwa-pairs` row shape (protocol "meteora-dlmm").
 * Row A/B are Meteora token X/Y. Rows cannot be opened yet.
 */
export function meteoraPairRow(pool: MeteoraPoolSummary): RwaPairRow {
  const { spec } = pool;
  // Freeze risk comes from Meteora's on-chain view of each mint's freeze authority.
  const freezeRiskA = pool.freezeAuthorityDisabledX === false, freezeRiskB = pool.freezeAuthorityDisabledY === false;
  return {
    poolAddress: pool.poolAddress,
    protocol: "meteora-dlmm",
    mintA: pool.mintX,
    mintB: pool.mintY,
    symbolA: pool.symbolX || spec.wrappedSymbol,
    symbolB: pool.symbolY || spec.plainSymbol,
    nameA: pool.nameX,
    nameB: pool.nameY,
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
    feeRate: pool.baseFeeRate,
    feeTierBps: pool.baseFeeBps,
    tvlUsd: pool.tvlUsd,
    volume24hUsd: pool.volume24hUsd,
    // LP share (gross fees minus Meteora's protocol fees).
    fees24hUsd: pool.lpFees24hUsd,
    raydiumFeeApr24h: null,
    estimatedFeeAprPct: pool.tvlUsd !== null && pool.lpFees24hUsd !== null ? estimateFeeAprPct(pool.lpFees24hUsd, pool.tvlUsd) : null,
    estimatedFeeAprLabel: FEE_APR_ESTIMATE_LABEL,
    token2022A: isToken2022Program(spec.tokenProgramX),
    token2022B: isToken2022Program(spec.tokenProgramY),
    freezeRiskA,
    freezeRiskB,
    freezeRisk: freezeRiskA || freezeRiskB,
  };
}

export type MeteoraPairsResult = {
  protocol: "meteora-dlmm";
  readOnly: true;
  pairs: RwaPairRow[];
  fetchedAt: string;
  source: string;
};

const CACHE_TTL_MS = 60_000;
let cache: { at: number; result: MeteoraPairsResult } | null = null;

export async function discoverMeteoraPairs(options: FetchMeteoraPoolsOptions & { bypassCache?: boolean } = {}): Promise<MeteoraPairsResult> {
  if (!options.bypassCache && cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.result;
  const pools = await fetchMeteoraPools(options);
  const result: MeteoraPairsResult = {
    protocol: "meteora-dlmm",
    readOnly: true,
    pairs: pools.map(meteoraPairRow),
    fetchedAt: new Date().toISOString(),
    source: "https://dlmm.datapi.meteora.ag/pools/{address} (allowlist: cbBTC/WBTC)",
  };
  if (!options.bypassCache) cache = { at: Date.now(), result };
  return result;
}
