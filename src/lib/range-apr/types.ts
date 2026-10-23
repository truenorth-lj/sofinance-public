/** Wire types shared by `/api/pool-range-apr`, the modal and the pair cards (client-safe). */
import type { AprBin, RangeAprEstimate } from "./range-apr";

export type RangeAprPresetId = "micro" | "tight" | "standard" | "wide";

export type RangeAprPresetEstimate = {
  id: RangeAprPresetId;
  tickLower: number;
  tickUpper: number;
  /** UI prices (B per 1 A) of the aligned boundaries. */
  priceLower: number;
  priceUpper: number;
  estimate: RangeAprEstimate;
  /** Client-side only: whether the typed deposit fits this range (see `size-aware.ts`). */
  sizeFit?: SizeFit;
};

/** Facts behind a size check: own share of active liquidity, nearer-edge distance and estimated impact. */
export type SizeFit = {
  status: "ok" | "excluded";
  reason?: "crowded" | "near-edge" | "cross-band";
  ownSharePct: number;
  edgeBps: number;
  impactBps: number;
  /** Distance (bps) to the nearer tick-spacing-band edge; prepare rejects a swap that leaves this band. */
  bandBps?: number;
};

export type SampleConfidence = "ok" | "low";
export type VolumeSource = "geckoterminal-daily" | "raydium-7d";
export type OccupancySource = "hourly-candles" | "current-price";

export type PoolRangeAprPayload = {
  poolId: string;
  fetchedAt: string;
  label: string;
  assumptions: string;
  pool: {
    tickSpacing: number;
    tickCurrent: number;
    /** B per 1 A. */
    currentPrice: number;
    decimalsA: number;
    decimalsB: number;
    feeRate: number;
    lpFeeFraction: number;
    tvlUsd: number | null;
  };
  /** Everything `estimateRangeApr` needs (except the capital) so custom ranges are computed in the browser. */
  model: {
    bins: AprBin[];
    currentSqrt: number;
    usdPerRawB: number;
    avgDailyVolumeUsd: number;
  };
  freshness?: { snapshotAt: string; chainObservedAt?: string; economicsObservedAt?: string; volumeObservedAt?: string; stale: boolean; lastAttemptStatus?: string };
  sample: {
    windowStartUtc?: string;
    windowEndUtc?: string;
    days: number;
    volumeSource: VolumeSource;
    occupancySource: OccupancySource;
    candleCount: number;
    /** Percent of sampled volume that could not be placed on a bin with liquidity (outside the window or in empty bins). */
    unplacedVolumePct: number;
    /** `low` when the sample is thin or much of the volume could not be placed; shown as a caveat in the UI. */
    confidence: SampleConfidence;
    /**
     * True when the price history needed to place volume on bins was unavailable (hourly candles missing). A
     * degraded payload carries NO estimates: every candidate is `unavailable` ("degraded-data") and the
     * client never ranks, headlines or highlights it.
     */
    degraded: boolean;
    /** Why upstream data was missing (for diagnosis), e.g. "GeckoTerminal hourly candles: Upstream request failed (429)". */
    issues: string[];
  };
  referenceCapitalUsd: number;
  presets: RangeAprPresetEstimate[];
  sources: string[];
  /** Raydium's own published 24h / 7d pool feeApr (gross, whole pool) for side-by-side display. */
  published: { dayFeeApr: number | null; weekFeeApr: number | null };
};
