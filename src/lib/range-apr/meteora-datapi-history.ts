/**
 * Seven complete UTC days of pool volume and hourly price history from Meteora's public datapi, in the shapes
 * the shared range-APR model reads from GeckoTerminal (`VolumeProfile.daily` / `candles`). Pure apart from the
 * injected fetcher.
 *
 * - Daily volume: ONE `volume/history?timeframe=24h` call (USD volume, fees and protocol fees per UTC day).
 * - Hourly candles: `ohlcv?timeframe=1h` serves at most ~4 days per call, so the window is read in two spans.
 * - Prices are token Y per token X (UI units); `baseMint`/`quoteMint` say so and `loadVolumeProfile` flips them
 *   when the pool's economics name the mints the other way round.
 * - A 429 or a timeout is never retried: it throws (`MeteoraDatapiError`) so a batch caller skips the pool and
 *   stops spending its budget; GeckoTerminal is never used as a fallback here.
 */
import { METEORA_DLMM_DATAPI } from "@sofinance/engine/protocols/meteora/constants";
import { SECONDS_PER_DAY, lastCompleteUtcDayStart } from "../apr-series";
import { averageDailyVolume, DATA_DAYS_LOOKBACK, VOLUME_WINDOW_DAYS } from "./daily-volume";
import type { RawCandle } from "./gecko-candles";
import { feeTotals, invertCandles, type DailyFeePoint, type FeeTotals, type PoolHistory, type PoolHistorySource } from "./pool-history";
import { fetchJsonOnce } from "./upstream-http";

export { feeTotals, invertCandles, type DailyFeePoint, type FeeTotals, type PoolHistory, type PoolHistorySource };

/** One OHLCV call covers at most this much (datapi caps 1h candles at ~4 days). */
export const DATAPI_HOURLY_SPAN_SECONDS = 84 * 3600;
export const DATAPI_TIMEOUT_MS = 5_000;

export type MeteoraDatapiFailure = "datapi-429" | "datapi-timeout";

/** A rate limit or timeout: the caller skips the pool (no retry, no fallback). */
export class MeteoraDatapiError extends Error {
  constructor(readonly code: MeteoraDatapiFailure, message: string) {
    super(message);
    this.name = "MeteoraDatapiError";
  }
}

type Json = Record<string, unknown>;
const record = (value: unknown): Json | null => (value && typeof value === "object" && !Array.isArray(value) ? value as Json : null);
const finite = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

/** `volume/history` rows; null when the body is not the documented shape. Bad rows are dropped. */
export function parseDatapiVolumeHistory(body: unknown): DailyFeePoint[] | null {
  const rows = record(body)?.data;
  if (!Array.isArray(rows)) return null;
  const points: DailyFeePoint[] = [];
  for (const row of rows) {
    const item = record(row);
    const time = finite(item?.timestamp), volumeUsd = finite(item?.volume);
    if (time === null || volumeUsd === null || volumeUsd < 0) continue;
    points.push({ time, volumeUsd, feesUsd: Math.max(0, finite(item?.fees) ?? 0), protocolFeesUsd: Math.max(0, finite(item?.protocol_fees) ?? 0) });
  }
  return points.sort((a, b) => a.time - b.time);
}

/** `ohlcv` rows as candles; null when the body is not the documented shape. Non-positive prices are dropped. */
export function parseDatapiOhlcv(body: unknown): RawCandle[] | null {
  const rows = record(body)?.data;
  if (!Array.isArray(rows)) return null;
  const candles: RawCandle[] = [];
  for (const row of rows) {
    const item = record(row);
    const time = finite(item?.timestamp), open = finite(item?.open), high = finite(item?.high);
    const low = finite(item?.low), close = finite(item?.close), volume = finite(item?.volume);
    if (time === null || open === null || high === null || low === null || close === null || volume === null) continue;
    if (!(open > 0 && high > 0 && low > 0 && close > 0) || volume < 0) continue;
    candles.push({ time, open, high, low, close, volume });
  }
  return candles;
}

/**
 * The OHLCV spans covering the complete days of the volume window (the open day is never priced), each
 * ≤ `DATAPI_HOURLY_SPAN_SECONDS`: two calls for 7 days.
 */
export function hourlySpans(nowSeconds: number, days = VOLUME_WINDOW_DAYS): { start: number; end: number }[] {
  const end = lastCompleteUtcDayStart(nowSeconds) + SECONDS_PER_DAY;
  const spans: { start: number; end: number }[] = [];
  for (let from = end - days * SECONDS_PER_DAY; from < end; from += DATAPI_HOURLY_SPAN_SECONDS) {
    spans.push({ start: from, end: Math.min(end, from + DATAPI_HOURLY_SPAN_SECONDS) });
  }
  return spans;
}

/**
 * Datapi's fees against the ON-CHAIN pool config (diagnosis only, shown as data notes): realised fees well
 * below the base fee, or a protocol cut far from the on-chain share, mean the volume series is suspect.
 * Datapi's realised rate runs a few percent under the base fee on calm pools (measured 0.93x), hence 0.9.
 */
export function datapiFeeCrossCheck(totals: FeeTotals, baseFeeRate: number, protocolShare: number): string[] {
  const { volumeUsd, feesUsd, protocolFeesUsd } = totals;
  if (!(volumeUsd > 0)) return [];
  const notes: string[] = [];
  const realisedRate = feesUsd / volumeUsd;
  // Dynamic fees only add to the base fee, so realised far below base means fees or volume are off.
  if (baseFeeRate > 0 && realisedRate < baseFeeRate * 0.9) {
    notes.push(`datapi 7d fees ${(realisedRate * 100).toFixed(4)}% of volume, below the ${(baseFeeRate * 100).toFixed(4)}% on-chain base fee`);
  }
  if (feesUsd > 0 && Math.abs(protocolFeesUsd / feesUsd - protocolShare) > 0.02) {
    notes.push(`datapi 7d protocol fees ${((protocolFeesUsd / feesUsd) * 100).toFixed(1)}% of fees, on-chain share ${(protocolShare * 100).toFixed(1)}%`);
  }
  return notes;
}

export type MeteoraDatapiHistoryOptions = {
  mintX: string;
  mintY: string;
  /** Pool creation time: the empty days datapi returns before it are not averaged in. */
  createdAtSeconds?: number;
  apiBase?: string;
  timeoutMs?: number;
};

export function meteoraDatapiHistory(options: MeteoraDatapiHistoryOptions): PoolHistorySource {
  const base = options.apiBase ?? METEORA_DLMM_DATAPI;
  const timeoutMs = options.timeoutMs ?? DATAPI_TIMEOUT_MS;
  return {
    name: "Meteora datapi",
    async load(poolId, fetcher, nowSeconds, signal) {
      const id = encodeURIComponent(poolId);
      const get = async (url: string) => {
        const result = await fetchJsonOnce(fetcher, url, timeoutMs, signal ? { signal } : {});
        if (result.ok) return { body: result.body, observedAt: new Date().toISOString() };
        if (result.status === 429) throw new MeteoraDatapiError("datapi-429", "Meteora datapi rate limited (429)");
        if (result.status === undefined && !signal?.aborted && /timeout|timed out/i.test(result.reason)) {
          throw new MeteoraDatapiError("datapi-timeout", `Meteora datapi timed out after ${timeoutMs} ms`);
        }
        if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("aborted");
        return { failure: result.reason };
      };
      const windowStart = lastCompleteUtcDayStart(nowSeconds) - (VOLUME_WINDOW_DAYS - 1) * SECONDS_PER_DAY;
      // Volume history reaches back `DATA_DAYS_LOOKBACK` days (one request either way) for the day count; the average
      // and the fee totals still use only the last `VOLUME_WINDOW_DAYS`.
      const lookbackStart = lastCompleteUtcDayStart(nowSeconds) - (DATA_DAYS_LOOKBACK - 1) * SECONDS_PER_DAY;
      const spans = hourlySpans(nowSeconds);
      const [daily, ...hourly] = await Promise.all([
        get(`${base}/pools/${id}/volume/history?timeframe=24h&start_time=${lookbackStart}&end_time=${nowSeconds}`),
        ...spans.map((span) => get(`${base}/pools/${id}/ohlcv?timeframe=1h&start_time=${span.start}&end_time=${span.end}`)),
      ]);
      const sources: string[] = [], issues: string[] = [];
      let dailySample: PoolHistory["daily"] = null, dailyPoints: DailyFeePoint[] = [];
      if ("body" in daily) {
        const points = parseDatapiVolumeHistory(daily.body);
        if (points) {
          // Days before the pool existed come back as zero rows; drop them (a missing day still counts as zero).
          dailyPoints = points.filter((point) => point.time >= windowStart && point.time < lastCompleteUtcDayStart(nowSeconds) + SECONDS_PER_DAY);
          const sample = averageDailyVolume(
            points.filter((point) => point.volumeUsd > 0).map((point) => ({ time: point.time, volumeUsd: point.volumeUsd })),
            nowSeconds, VOLUME_WINDOW_DAYS, options.createdAtSeconds,
          );
          if (sample) { dailySample = { ...sample, source: "meteora-datapi-daily" }; sources.push(`${base}/pools/{address}/volume/history (24h USD volume)`); }
          else issues.push("Meteora datapi volume history: no complete days");
        } else issues.push("Meteora datapi volume history: unusable response");
      } else issues.push(`Meteora datapi volume history: ${daily.failure}`);
      let candles: RawCandle[] | null = null;
      const failed = hourly.find((part): part is { failure: string } => "failure" in part);
      if (failed) issues.push(`Meteora datapi hourly candles: ${failed.failure}`);
      else {
        const parsed = hourly.map((part) => ("body" in part ? parseDatapiOhlcv(part.body) : null));
        if (parsed.some((part) => part === null)) issues.push("Meteora datapi hourly candles: unusable response");
        else {
          const byTime = new Map<number, RawCandle>();
          for (const candle of parsed.flat() as RawCandle[]) byTime.set(candle.time, candle);
          candles = [...byTime.values()].sort((a, b) => a.time - b.time);
          sources.push(`${base}/pools/{address}/ohlcv 1h (price path, Y per X; ${spans.length} spans)`);
        }
      }
      const hourlyObserved = hourly.map((part) => ("observedAt" in part ? part.observedAt : null)).filter((at): at is string => at !== null);
      return {
        daily: dailySample, candles, baseMint: options.mintX, quoteMint: options.mintY, dailyPoints, sources, issues,
        observedAt: { daily: "observedAt" in daily && dailySample ? daily.observedAt ?? null : null, hourly: candles?.length ? hourlyObserved.at(-1) ?? null : null },
      };
    },
  };
}
