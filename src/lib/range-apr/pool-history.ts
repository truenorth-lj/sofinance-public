/**
 * Protocol-neutral price/volume history injected into the range-APR profile (`UpstreamOptions.history`), for
 * pools whose history comes from somewhere other than GeckoTerminal. Concrete sources live per protocol.
 */
import type { DailyVolumeSample } from "./daily-volume";
import type { RawCandle } from "./gecko-candles";
import type { VolumeSource } from "./types";

export type DailyFeePoint = { time: number; volumeUsd: number; feesUsd: number; protocolFeesUsd: number };

export type PoolHistory = {
  daily: (DailyVolumeSample & { source: VolumeSource }) | null;
  /** Hourly candles, price = quote per base (UI units), USD volume. */
  candles: RawCandle[] | null;
  baseMint: string;
  quoteMint: string;
  /** Complete days in the window, for the fee cross-check. */
  dailyPoints: DailyFeePoint[];
  sources: string[];
  issues: string[];
  observedAt: { daily: string | null; hourly: string | null };
};

/** Pluggable volume + price-history loader for `loadVolumeProfile` (replaces the GeckoTerminal calls). */
export type PoolHistorySource = {
  name: string;
  load: (poolId: string, fetcher: typeof fetch, nowSeconds: number, signal?: AbortSignal) => Promise<PoolHistory>;
};

/** Same candles priced the other way round (base per quote): 1/p, with high and low swapped. */
export function invertCandles(candles: readonly RawCandle[]): RawCandle[] {
  return candles.map((candle) => ({
    time: candle.time, open: 1 / candle.open, high: 1 / candle.low, low: 1 / candle.high, close: 1 / candle.close, volume: candle.volume,
  }));
}

/** Traded volume and fees summed over the complete days of the window. */
export type FeeTotals = { volumeUsd: number; feesUsd: number; protocolFeesUsd: number };

export function feeTotals(points: readonly DailyFeePoint[]): FeeTotals {
  return points.reduce((sum, point) => ({
    volumeUsd: sum.volumeUsd + point.volumeUsd, feesUsd: sum.feesUsd + point.feesUsd, protocolFeesUsd: sum.protocolFeesUsd + point.protocolFeesUsd,
  }), { volumeUsd: 0, feesUsd: 0, protocolFeesUsd: 0 });
}
