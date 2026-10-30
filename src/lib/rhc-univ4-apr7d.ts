import { GECKOTERMINAL_ATTRIBUTION, GECKOTERMINAL_NETWORK } from "@sofinance/engine/protocols/uniswap-v4/market-data";
import type { GeckoVolumePoint } from "./pool-daily-apr-math";
import { averageDailyVolume, VOLUME_WINDOW_DAYS } from "./range-apr/daily-volume";

/**
 * Robinhood Chain 7-day pool fee APR (pure; PM 2026-10-30): the same public-API method as the Solana 7-day volume
 * average — GeckoTerminal daily USD volume, complete UTC days only, a day without a candle counts as zero, a pool
 * younger than 7 days averages over its own age (`averageDailyVolume`) — × the hook's current fee rate / TVL × 365.
 * No RPC: the fee rate is the one discovery already read and TVL is the indexer's (DexScreener, GeckoTerminal fallback).
 * Whole-pool figure (every LP's share of fees), not a range estimate: the pool has no range model.
 */
export type RhcPoolApr7d = {
  estimated: true;
  basis: "7d-avg-daily-volume";
  source: "geckoterminal";
  attribution: typeof GECKOTERMINAL_ATTRIBUTION;
  /** Complete UTC days averaged (≤ 7). */
  days: number;
  avgDailyVolumeUsd: number;
  tvlUsd: number;
  /** Hook's current LP fee (mean of both directions), percent. */
  feeRatePct: number;
  /** fee rate × average daily volume / TVL × 365, percent. */
  estimatedPoolFeeAprPct: number;
};

export const rhcDailyOhlcvUrl = (poolId: string) =>
  `https://api.geckoterminal.com/api/v2/networks/${GECKOTERMINAL_NETWORK}/pools/${poolId.toLowerCase()}/ohlcv/day?aggregate=1&limit=30&currency=usd`;

/** Null (shown as "—", never 0%) when there is no daily data, no fee reading or no positive TVL. */
export function rhcPoolApr7d(input: {
  points: readonly GeckoVolumePoint[] | null;
  nowSeconds: number;
  feePips: { zeroForOne: number; oneForZero: number } | null;
  tvlUsd: number | null | undefined;
}): RhcPoolApr7d | null {
  const { points, nowSeconds, feePips, tvlUsd } = input;
  if (!points || !feePips || typeof tvlUsd !== "number" || !Number.isFinite(tvlUsd) || tvlUsd <= 0) return null;
  const sample = averageDailyVolume(points, nowSeconds, VOLUME_WINDOW_DAYS);
  if (!sample) return null;
  const feeRate = (feePips.zeroForOne + feePips.oneForZero) / 2 / 1_000_000;
  if (!Number.isFinite(feeRate) || feeRate < 0) return null;
  return {
    estimated: true, basis: "7d-avg-daily-volume", source: "geckoterminal", attribution: GECKOTERMINAL_ATTRIBUTION,
    days: sample.days, avgDailyVolumeUsd: sample.avgDailyVolumeUsd, tvlUsd, feeRatePct: feeRate * 100,
    estimatedPoolFeeAprPct: (feeRate * sample.avgDailyVolumeUsd / tvlUsd) * 365 * 100,
  };
}
