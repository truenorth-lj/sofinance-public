import "@/lib/engine-host";
import { OPEN_RANGE_PRESETS } from "@sofinance/engine/open-range-presets";
import { getRwaPairs } from "../../lib/rwa-store";
import { FEED_KEY } from "../../lib/rwa-store-types";
import { buildOpenPositionUrl } from "../../lib/public-urls";
import type { ListRwaPairsInput } from "../schemas";

/**
 * List Raydium CLMM pools where both sides are the same underlying RWA
 * (wrapped vs unwrapped / xStock style), plus the curated USDC/USDT pool,
 * with fee/TVL/yield annotations.
 * Filter: Jupiter Tokens API tags (stocks|rwa) + Backed xStocks whitelist + curated CLMM allowlist.
 *
 * Safety: Read-only; uses public Raydium / Jupiter / xStocks APIs. No wallet or private keys.
 */
export async function listRwaPairs(input: ListRwaPairsInput) {
  // Raydium feed only: every row here has a Raydium `openPositionUrl`.
  const result = await getRwaPairs({ minTvl: input.minTvl, maxPages: input.maxPages, sortBy: input.sortBy, feedKeys: [FEED_KEY] });

  return {
    pairingRule: result.pairingRuleSummary,
    estimatedFeeAprLabel: result.estimatedFeeAprLabel,
    source: result.source,
    fetchedAt: result.fetchedAt,
    scannedPools: result.scannedPools,
    pagesFetched: result.pagesFetched,
    count: result.pairs.length,
    pairs: result.pairs.map((pair) => ({
      poolAddress: pair.poolAddress,
      mintA: pair.mintA,
      mintB: pair.mintB,
      symbolA: pair.symbolA,
      symbolB: pair.symbolB,
      nameA: pair.nameA,
      nameB: pair.nameB,
      baseSymbol: pair.baseSymbol,
      wrappedSymbol: pair.wrappedSymbol,
      plainSymbol: pair.plainSymbol,
      wrapKind: pair.wrapKind,
      relatedness: pair.relatedness,
      qualificationA: pair.qualificationA,
      qualificationB: pair.qualificationB,
      preferredTags: pair.preferredTags,
      jupiterTagsA: pair.jupiterTagsA,
      jupiterTagsB: pair.jupiterTagsB,
      feeRate: pair.feeRate,
      feeTierBps: pair.feeTierBps,
      tvlUsd: pair.tvlUsd,
      volume24hUsd: pair.volume24hUsd,
      fees24hUsd: pair.fees24hUsd,
      raydiumFeeApr24h: pair.raydiumFeeApr24h,
      estimatedFeeAprPct: pair.estimatedFeeAprPct,
      estimatedFeeAprLabel: pair.estimatedFeeAprLabel,
      token2022A: pair.token2022A,
      token2022B: pair.token2022B,
      freezeRiskA: pair.freezeRiskA,
      freezeRiskB: pair.freezeRiskB,
      freezeRisk: pair.freezeRisk,
      openPositionUrl: buildOpenPositionUrl(pair.poolAddress),
      recommendedRanges: OPEN_RANGE_PRESETS,
    })),
  };
}


