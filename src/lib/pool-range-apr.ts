import "server-only";

import { AsyncCache } from "./async-cache";
import { createConcurrencyLimit } from "./concurrency-limit";
import { GECKO_TERMINAL_OHLCV, RAYDIUM_POOL_IDS, safeJson } from "./pool-daily-apr";
import { parseGeckoDailyVolumes } from "./pool-daily-apr-math";
import { buildAprBins, lpFeeFraction, sampleConfidence, usdPerRawTokenB } from "./range-apr/build-model";
import { candlesInWindow, averageDailyVolume, VOLUME_WINDOW_DAYS } from "./range-apr/daily-volume";
import { orientCandles, parseGeckoHourlyCandles, type RawCandle } from "./range-apr/gecko-candles";
import { binVolumeShares, candlesToTickCandles, type OccupancyResult } from "./range-apr/occupancy";
import { readOnchainPoolLiquidity, type OnchainPoolLiquidity } from "./range-apr/onchain-liquidity";
import { resolvePresetRanges } from "./range-apr/preset-ranges";
import { estimateRangeApr, RANGE_APR_REFERENCE_CAPITAL_USD, type RangeAprInputs } from "./range-apr/range-apr";
import { parseRaydiumPoolEconomics, type RaydiumPoolEconomics } from "./range-apr/raydium-economics";
import { exactTickFromSqrtPriceX64, sqrtPriceX64ToNumber } from "./range-apr/tick-math";
import { retryJson, type RetryOptions } from "./range-apr/upstream-retry";
import type { OccupancySource, PoolRangeAprPayload, VolumeSource } from "./range-apr/types";
import type { Connection } from "@solana/web3.js";

export const RANGE_APR_LABEL = "Est. fee APR";

export const RANGE_APR_ASSUMPTIONS = [
  `Estimate, not a guarantee. Back-tests the last ${VOLUME_WINDOW_DAYS} complete UTC days of pool volume (GeckoTerminal, current day excluded) against the pool's liquidity right now (on-chain tick arrays).`,
  "Fees = volume that traded inside your range × pool fee rate × the share LPs keep (Raydium keeps protocol + fund cuts) × your share of the liquidity in each price bin.",
  "Volume only counts while the price is inside your range, using hourly price history; time out of range earns nothing.",
  "Assumes volume, other LPs' liquidity and prices behave like the recent past. Excludes impermanent loss, rewards, swap and rent costs.",
  `Rate shown for a ~$${RANGE_APR_REFERENCE_CAPITAL_USD} deposit; larger deposits dilute their own share of the fees.`,
].join(" ");

const ECONOMICS_TTL_MS = 30 * 60_000;
const CHAIN_TTL_MS = 30_000;
const FAILURE_TTL_MS = 15_000;
/** A profile without price history is retried quickly instead of being served for 30 minutes. */
const DEGRADED_TTL_MS = 10_000;
/** A profile rebuilt from an older good one (upstream failed just now) is re-checked after a minute. */
const STALE_TTL_MS = 60_000;
/** Price history from an earlier good fetch may stand in for a failed one for this long. */
const STALE_GOOD_MAX_MS = 6 * 3_600_000;
const UPSTREAM_TIMEOUT_MS = 5_000;
/** GeckoTerminal is rate limited per egress IP (shared on serverless): never run more than 2 calls at once per instance. */
const geckoLimit = createConcurrencyLimit(2);

export type VolumeProfile = {
  observedAt?: { economics: string; daily: string | null; hourly: string | null };
  economics: RaydiumPoolEconomics;
  daily: { avgDailyVolumeUsd: number; days: number } | null;
  candles: RawCandle[] | null;
  sources: string[];
  /** Why upstream pieces were missing (diagnosis; shown in the payload). */
  issues: string[];
  /** Built from an earlier good fetch because the latest one failed. */
  stale?: boolean;
};

/** Hourly price history is what places volume on bins; without it no estimate is trustworthy. */
export function hasPriceHistory(profile: Pick<VolumeProfile, "candles">): boolean {
  return profile.candles !== null && profile.candles.length > 0;
}

const profileTtl = (profile: VolumeProfile) =>
  !hasPriceHistory(profile) ? DEGRADED_TTL_MS : profile.stale ? STALE_TTL_MS : ECONOMICS_TTL_MS;

const volumeCache = new AsyncCache<VolumeProfile>({ ttlMs: ECONOMICS_TTL_MS, failureTtlMs: FAILURE_TTL_MS, ttlFor: profileTtl });
const chainCache = new AsyncCache<OnchainPoolLiquidity>({ ttlMs: CHAIN_TTL_MS, failureTtlMs: FAILURE_TTL_MS });
const lastGoodProfiles = new Map<string, { atMs: number; profile: VolumeProfile }>();

export function clearPoolRangeAprCache() {
  volumeCache.clear();
  chainCache.clear();
  lastGoodProfiles.clear();
}

export type FetchPoolRangeAprOptions = {
  fetcher?: typeof fetch;
  connection?: Connection;
  nowSeconds?: number;
  bypassCache?: boolean;
  /** Retry tuning for upstream calls (tests pass a no-op `sleep`). */
  retry?: RetryOptions;
};

export async function loadVolumeProfile(
  poolId: string, fetcher: typeof fetch, nowSeconds: number, retry: RetryOptions = {},
): Promise<VolumeProfile> {
  const id = encodeURIComponent(poolId);
  const get = async (url: string) => { const result = await retryJson(() => safeJson(fetcher, url, UPSTREAM_TIMEOUT_MS, retry.signal), { attempts: 3, baseDelayMs: 300, maxDelayMs: 1_500, ...retry }); return { ...result, observedAt: new Date().toISOString() }; };
  const getGecko = (url: string) => geckoLimit(() => get(url));
  const [ids, daily, hourly] = await Promise.all([
    get(`${RAYDIUM_POOL_IDS}?ids=${id}`),
    getGecko(`${GECKO_TERMINAL_OHLCV}/${id}/ohlcv/day?aggregate=1&limit=30&currency=usd`),
    getGecko(`${GECKO_TERMINAL_OHLCV}/${id}/ohlcv/hour?aggregate=1&limit=200&currency=token`),
  ]);
  const economics = ids.ok ? parseRaydiumPoolEconomics(ids.body) : null;
  if (!economics) throw new Error("Pool economics unavailable from Raydium");
  const sources = [`${RAYDIUM_POOL_IDS} (feeRate, TVL, token amounts, fee cuts)`];
  const issues: string[] = [];
  const dailySample = daily.ok ? averageDailyVolume(parseGeckoDailyVolumes(daily.body), nowSeconds) : null;
  if (dailySample) sources.push(`${GECKO_TERMINAL_OHLCV}/{pool}/ohlcv/day (USD volume)`);
  else issues.push(`GeckoTerminal daily candles: ${daily.ok ? "no complete days" : daily.reason}`);
  let candles: RawCandle[] | null = null;
  if (hourly.ok) {
    candles = orientCandles(parseGeckoHourlyCandles(hourly.body), economics.mintA, economics.mintB);
    if (candles) sources.push(`${GECKO_TERMINAL_OHLCV}/{pool}/ohlcv/hour (price path, token currency)`);
    else issues.push("GeckoTerminal hourly candles: unusable response");
  } else {
    issues.push(`GeckoTerminal hourly candles: ${hourly.reason}`);
  }
  return { economics, daily: dailySample, candles, sources, issues, observedAt: { economics: ids.observedAt, daily: dailySample ? daily.observedAt : null, hourly: candles?.length ? hourly.observedAt : null } };
}

/**
 * `loadVolumeProfile` with stale-if-error: when this fetch lost its price history but an earlier one for the
 * same pool (< 6 h) had it, keep the old history/volume with fresh economics instead of degrading.
 */
export async function loadVolumeProfileResilient(
  poolId: string, fetcher: typeof fetch, nowSeconds: number, retry: RetryOptions = {},
): Promise<VolumeProfile> {
  const fresh = await loadVolumeProfile(poolId, fetcher, nowSeconds, retry);
  const nowMs = nowSeconds * 1000;
  if (hasPriceHistory(fresh)) {
    lastGoodProfiles.set(poolId, { atMs: nowMs, profile: fresh });
    return fresh;
  }
  const last = lastGoodProfiles.get(poolId);
  if (!last || nowMs - last.atMs > STALE_GOOD_MAX_MS) return fresh;
  const minutes = Math.round((nowMs - last.atMs) / 60_000);
  return {
    ...fresh,
    daily: fresh.daily ?? last.profile.daily,
    candles: last.profile.candles,
    sources: last.profile.sources,
    issues: [...fresh.issues, `using price history cached ${minutes} min ago`],
    stale: true,
  };
}

type Volume = { avgDailyVolumeUsd: number; days: number; source: VolumeSource };

function pickVolume(profile: VolumeProfile): Volume | null {
  if (profile.daily) return { ...profile.daily, source: "geckoterminal-daily" };
  const week = profile.economics.weekVolumeUsd;
  return week === null ? null : { avgDailyVolumeUsd: week / 7, days: 7, source: "raydium-7d" };
}

/** Pure assembly of the cached upstream pieces into the wire payload. Exported for tests. */
export function assemblePoolRangeApr(
  poolId: string, profile: VolumeProfile, chain: OnchainPoolLiquidity, nowSeconds: number,
  options: { rebase?: boolean } = {},
): PoolRangeAprPayload {
  const { economics } = profile;
  const volume = pickVolume(profile);
  if (!volume) throw new Error("Pool volume unavailable");
  const usdPerRawB = usdPerRawTokenB({
    tvlUsd: economics.tvlUsd, mintAmountA: economics.mintAmountA, mintAmountB: economics.mintAmountB,
    priceBPerA: economics.price, decimalsB: chain.decimalsB,
  });
  if (usdPerRawB === null) throw new Error("Pool TVL unavailable");

  const windowCandles = profile.candles
    ? candlesInWindow(profile.candles, nowSeconds, volume.days)
    : [];
  const occupancy: OccupancyResult | null = windowCandles.length > 0
    ? binVolumeShares(
      candlesToTickCandles(windowCandles, {
        decimalsA: chain.decimalsA, decimalsB: chain.decimalsB, feeRate: economics.feeRate,
        currentExactTick: exactTickFromSqrtPriceX64(chain.sqrtPriceX64), rebase: options.rebase,
      }),
      chain.bins, chain.tickSpacing,
    )
    : null;
  const occupancySource: OccupancySource = occupancy ? "hourly-candles" : "current-price";
  const unplacedVolumePct = occupancy ? occupancy.outsideShare * 100 : 0;
  const bins = buildAprBins(chain.bins, occupancy, volume.avgDailyVolumeUsd, chain.tickCurrent, chain.tickSpacing);
  const currentSqrt = sqrtPriceX64ToNumber(chain.sqrtPriceX64);
  const fraction = lpFeeFraction(economics.protocolFeeRate, economics.fundFeeRate);
  const inputs: RangeAprInputs = {
    tickSpacing: chain.tickSpacing, bins, currentSqrt, usdPerRawB, feeRate: economics.feeRate,
    lpFeeFraction: fraction, avgDailyVolumeUsd: volume.avgDailyVolumeUsd, capitalUsd: RANGE_APR_REFERENCE_CAPITAL_USD,
  };
  // Without price history there is nothing to place volume on, so the number would be a guess that depends on
  // which upstream happened to answer. Ship the ranges but no estimate ("degraded-data"): the client never
  // ranks, headlines or highlights them (see `docs/rwa-range-apr.md`).
  const degraded = occupancy === null;
  const presets = resolvePresetRanges(chain).map((range) => ({
    ...range,
    estimate: degraded
      ? { status: "unavailable" as const, reason: "degraded-data" as const }
      : estimateRangeApr(inputs, range),
  }));
  return {
    poolId,
    fetchedAt: new Date(nowSeconds * 1000).toISOString(),
    label: RANGE_APR_LABEL,
    assumptions: RANGE_APR_ASSUMPTIONS,
    pool: {
      tickSpacing: chain.tickSpacing, tickCurrent: chain.tickCurrent, currentPrice: economics.price,
      decimalsA: chain.decimalsA, decimalsB: chain.decimalsB, feeRate: economics.feeRate,
      lpFeeFraction: fraction, tvlUsd: economics.tvlUsd,
    },
    model: { bins, currentSqrt, usdPerRawB, avgDailyVolumeUsd: volume.avgDailyVolumeUsd },
    sample: {
      days: volume.days, volumeSource: volume.source, occupancySource,
      candleCount: windowCandles.length,
      unplacedVolumePct,
      confidence: sampleConfidence({ days: volume.days, volumeSource: volume.source, occupancySource, unplacedVolumePct }),
      degraded,
      issues: profile.issues,
    },
    referenceCapitalUsd: RANGE_APR_REFERENCE_CAPITAL_USD,
    presets,
    sources: [...profile.sources, "Solana RPC: CLMM pool account + tick arrays (liquidity per price bin)"],
    published: { dayFeeApr: economics.dayFeeApr, weekFeeApr: economics.weekFeeApr },
  };
}

export async function fetchPoolRangeApr(
  poolId: string, options: FetchPoolRangeAprOptions = {},
): Promise<PoolRangeAprPayload> {
  const fetcher = options.fetcher ?? fetch;
  const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const loadProfile = () => loadVolumeProfileResilient(poolId, fetcher, nowSeconds, options.retry);
  const loadChain = () => readOnchainPoolLiquidity(poolId, options.connection);
  const [profile, chain] = options.bypassCache
    ? await Promise.all([loadProfile(), loadChain()])
    : await Promise.all([volumeCache.get(poolId, loadProfile), chainCache.get(poolId, loadChain)]);
  return assemblePoolRangeApr(poolId, profile, chain, nowSeconds);
}

