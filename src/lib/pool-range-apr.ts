import "@/lib/engine-host";
import "server-only";

import { AsyncCache } from "./async-cache";
import { RAYDIUM_POOL_IDS } from "./pool-daily-apr";
import { geckoGate, geckoOhlcvUrl, geckoPoolsUrl, type GeckoNetwork } from "./pool-metrics/gecko";
import { parseGeckoDailyVolumes } from "./pool-daily-apr-math";
import { buildAprBins, lpFeeFraction, sampleConfidence, usdPerRawTokenB } from "./range-apr/build-model";
import { candlesInWindow, averageDailyVolume, VOLUME_WINDOW_DAYS } from "./range-apr/daily-volume";
import { orientCandles, parseGeckoHourlyCandles, type RawCandle } from "./range-apr/gecko-candles";
import { binVolumeShares, candlesToTickCandles, type OccupancyResult } from "./range-apr/occupancy";
import { readOnchainPoolLiquidity, type OnchainPoolLiquidity } from "./range-apr/onchain-liquidity";
import { resolvePresetRanges, type PresetTickRange } from "./range-apr/preset-ranges";
import { estimateRangeApr, RANGE_APR_REFERENCE_CAPITAL_USD, type RangeAprInputs } from "./range-apr/range-apr";
import { parseRaydiumPoolEconomics, type PoolEconomics } from "./range-apr/raydium-economics";
import { exactTickFromSqrtPriceX64, sqrtPriceX64ToNumber } from "@sofinance/engine/range-apr/tick-math";
import type { ThrottleGate } from "./range-apr/throttle-gate";
import { fetchJsonOnce } from "./range-apr/upstream-http";
import { isRetryableFailure, retryJson, type JsonResult, type RetryOptions } from "./range-apr/upstream-retry";
import type { OccupancySource, PoolRangeAprPayload, VolumeSource } from "./range-apr/types";
import type { Connection } from "@solana/web3.js";

export const RANGE_APR_LABEL = "Est. fee APR";
export const SOLANA_CLMM_CHAIN_SOURCE = "Solana RPC: CLMM pool account + tick arrays (liquidity per price bin)";

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
/**
 * A profile without price history is re-checked after this long: long enough that a throttled upstream is not
 * hammered (and GeckoTerminal's cooldown can pass), short enough to self-heal within a minute.
 */
const DEGRADED_TTL_MS = 45_000;
/** A profile rebuilt from an older good one (upstream failed just now) is re-checked after a minute. */
const STALE_TTL_MS = 60_000;
/** Price history from an earlier good fetch may stand in for a failed one for this long. */
const STALE_GOOD_MAX_MS = 6 * 3_600_000;
const UPSTREAM_TIMEOUT_MS = 5_000;
/**
 * Shared Data Cache (Vercel): successful upstream responses are stored for all instances and survive cold
 * starts, and an expired entry is served stale while it revalidates, so a 429 on revalidation costs nothing.
 * Candles of past hours never change, so a long window is safe; the current partial hour is the only drift.
 */
const HOURLY_REVALIDATE_S = 30 * 60;
const DAILY_REVALIDATE_S = 60 * 60;
const ECONOMICS_REVALIDATE_S = 5 * 60;
/** The shared GeckoTerminal gate (one per instance for every pool-metrics path, see `pool-metrics/gecko.ts`). */
export { geckoGate };

export type VolumeProfile = {
  observedAt?: { economics: string; daily: string | null; hourly: string | null };
  economics: PoolEconomics;
  /** Protocol whose published economics back the `protocol-7d` volume fallback (e.g. "raydium-clmm"). */
  protocol?: string;
  daily: { avgDailyVolumeUsd: number; days: number } | null;
  candles: RawCandle[] | null;
  sources: string[];
  /** Why upstream pieces were missing (diagnosis; shown in the payload). */
  issues: string[];
  /** Built from an earlier good fetch because the latest one failed. */
  stale?: boolean;
};

/**
 * Hourly price history is what places volume on bins; without it no estimate is trustworthy. A pool that
 * traded nothing in the window (daily volume known and zero) legitimately has no candles: that is "no
 * history needed" rather than "history missing", and its estimate is an honest 0%.
 */
export function hasPriceHistory(profile: Pick<VolumeProfile, "candles" | "daily">): boolean {
  if (profile.candles === null) return false;
  return profile.candles.length > 0 || profile.daily?.avgDailyVolumeUsd === 0;
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
  /** GeckoTerminal throttle gate (tests pass their own so cooldown state does not leak). */
  gate?: ThrottleGate;
};

/**
 * Where pool-level economics (fee rate, TVL, token amounts, fee cuts) come from. Defaults to Raydium API v3;
 * other protocols pass their own parser into the same `PoolEconomics` shape, or a `load` function when the
 * economics are not one JSON GET.
 */
type EconomicsSourceBase = {
  name: string;
  /** Protocol id recorded with the `protocol-7d` volume fallback. */
  protocol: string;
  source: string;
};
/** One JSON GET parsed into `PoolEconomics` (HTTP protocol APIs). */
export type HttpPoolEconomicsSource = EconomicsSourceBase & {
  url: (encodedPoolId: string) => string; parse: (body: unknown) => PoolEconomics | null; load?: never;
};
/** Anything else (on-chain fee + indexer TVL, loaded without a single JSON GET). */
export type LoadedPoolEconomicsSource = EconomicsSourceBase & {
  load: (poolId: string, fetcher: typeof fetch, signal?: AbortSignal) => Promise<PoolEconomics | null>; url?: never; parse?: never;
};
export type PoolEconomicsSource = HttpPoolEconomicsSource | LoadedPoolEconomicsSource;

export const RAYDIUM_ECONOMICS_SOURCE: HttpPoolEconomicsSource = {
  name: "Raydium",
  protocol: "raydium-clmm",
  url: (id) => `${RAYDIUM_POOL_IDS}?ids=${id}`,
  parse: parseRaydiumPoolEconomics,
  source: `${RAYDIUM_POOL_IDS} (feeRate, TVL, token amounts, fee cuts)`,
};

type UpstreamOptions = Pick<FetchPoolRangeAprOptions, "retry" | "gate"> & {
  economics?: PoolEconomicsSource;
  /** GeckoTerminal network for the candles (default solana). */
  network?: GeckoNetwork;
};

/** Next's Data Cache hint; ignored by injected test fetchers. */
const cached = (revalidateSeconds: number, signal?: AbortSignal): RequestInit => ({ next: { revalidate: revalidateSeconds }, ...(signal ? { signal } : {}) });

/** A 429 is never retried (it only deepens the throttle): the gate's cooldown and the caches take over. */
const notThrottled = (failure: Extract<JsonResult, { ok: false }>) =>
  failure.status !== 429 && isRetryableFailure(failure.reason);

export async function loadVolumeProfile(
  poolId: string, fetcher: typeof fetch, nowSeconds: number, upstream: UpstreamOptions = {},
): Promise<VolumeProfile> {
  const network = upstream.network ?? "solana";
  const geckoBase = geckoPoolsUrl(network);
  const gate = upstream.gate ?? geckoGate;
  const retryOptions = { attempts: 3, baseDelayMs: 300, maxDelayMs: 1_500, ...upstream.retry };
  const signal = upstream.retry?.signal;
  const observed = async (result: Promise<JsonResult>) => ({ ...(await result), observedAt: new Date().toISOString() });
  const economicsSource = upstream.economics ?? RAYDIUM_ECONOMICS_SOURCE;
  const getRaydium = (url: string) => observed(
    retryJson(() => fetchJsonOnce(fetcher, url, UPSTREAM_TIMEOUT_MS, cached(ECONOMICS_REVALIDATE_S, signal)), retryOptions));
  const getGecko = (url: string, revalidateSeconds: number) => observed(getGeckoRaw(url, revalidateSeconds));
  const getGeckoRaw = async (url: string, revalidateSeconds: number): Promise<JsonResult> => {
    const run = await gate.run(() => retryJson(
      async () => {
        const result = await fetchJsonOnce(fetcher, url, UPSTREAM_TIMEOUT_MS, cached(revalidateSeconds, signal));
        if (!result.ok && result.status === 429) gate.block(result.retryAfterMs);
        return result;
      },
      { ...retryOptions, attempts: Math.min(retryOptions.attempts, 2), shouldRetry: notThrottled },
    ));
    return "value" in run
      ? run.value
      : { ok: false, reason: `throttled (429); cooling down ${Math.ceil(run.blocked / 1000)}s` };
  };
  const loadEconomics = async (): Promise<{ economics: PoolEconomics | null; observedAt: string }> => {
    if (economicsSource.load) {
      const economics = await economicsSource.load(poolId, fetcher, signal).catch(() => null);
      return { economics, observedAt: new Date().toISOString() };
    }
    const ids = await getRaydium(economicsSource.url(encodeURIComponent(poolId)));
    return { economics: ids.ok ? economicsSource.parse(ids.body) : null, observedAt: ids.observedAt };
  };
  const [ids, daily, hourly] = await Promise.all([
    loadEconomics(),
    getGecko(geckoOhlcvUrl(network, poolId, "day", { limit: 30, currency: "usd" }), DAILY_REVALIDATE_S),
    getGecko(geckoOhlcvUrl(network, poolId, "hour", { limit: 200, currency: "token" }), HOURLY_REVALIDATE_S),
  ]);
  const economics = ids.economics;
  if (!economics) throw new Error(`Pool economics unavailable from ${economicsSource.name}`);
  const sources = [economicsSource.source];
  const issues: string[] = [];
  const dailySample = daily.ok ? averageDailyVolume(parseGeckoDailyVolumes(daily.body), nowSeconds) : null;
  if (dailySample) sources.push(`${geckoBase}/{pool}/ohlcv/day (USD volume)`);
  else issues.push(`GeckoTerminal daily candles: ${daily.ok ? "no complete days" : daily.reason}`);
  let candles: RawCandle[] | null = null;
  if (hourly.ok) {
    candles = orientCandles(parseGeckoHourlyCandles(hourly.body), economics.mintA, economics.mintB);
    if (candles) sources.push(`${geckoBase}/{pool}/ohlcv/hour (price path, token currency)`);
    else issues.push("GeckoTerminal hourly candles: unusable response");
  } else {
    issues.push(`GeckoTerminal hourly candles: ${hourly.reason}`);
  }
  return { economics, protocol: economicsSource.protocol, daily: dailySample, candles, sources, issues, observedAt: { economics: ids.observedAt, daily: dailySample ? daily.observedAt : null, hourly: candles?.length ? hourly.observedAt : null } };
}

/**
 * `loadVolumeProfile` with stale-if-error: when this fetch lost its price history but an earlier one for the
 * same pool (< 6 h) had it, keep the old history/volume with fresh economics instead of degrading.
 */
export async function loadVolumeProfileResilient(
  poolId: string, fetcher: typeof fetch, nowSeconds: number, upstream: UpstreamOptions = {},
): Promise<VolumeProfile> {
  const fresh = await loadVolumeProfile(poolId, fetcher, nowSeconds, upstream);
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

type Volume = { avgDailyVolumeUsd: number; days: number; source: VolumeSource; protocol?: string };

/**
 * Average daily volume, in order: GeckoTerminal daily candles (the complete days that exist, up to 7: D4), then
 * the protocol's own published 7-day volume. Snapshots saved before this label fix say "raydium-7d".
 */
export function pickVolume(profile: Pick<VolumeProfile, "daily" | "economics" | "protocol">): Volume | null {
  if (profile.daily) return { ...profile.daily, source: "geckoterminal-daily" };
  const week = profile.economics.weekVolumeUsd;
  return week === null ? null : { avgDailyVolumeUsd: week / 7, days: 7, source: "protocol-7d", protocol: profile.protocol ?? "raydium-clmm" };
}

export type AssembleOptions = {
  rebase?: boolean;
  /** Candidate ranges to price; defaults to the Solana CLMM presets (`resolvePresetRanges`). */
  presets?: readonly PresetTickRange[];
  /** Source line for the liquidity read (defaults to the Solana CLMM one). */
  chainSource?: string;
  /** Assumptions copy (defaults to the Raydium wording). */
  assumptions?: string;
};

/** Pure assembly of the cached upstream pieces into the wire payload. Exported for tests. */
export function assemblePoolRangeApr(
  poolId: string, profile: VolumeProfile, chain: OnchainPoolLiquidity, nowSeconds: number,
  options: AssembleOptions = {},
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
  // The exception is a pool that traded nothing in the window: no volume to place, an honest 0%.
  const idle = occupancy === null && hasPriceHistory(profile);
  const degraded = occupancy === null && !idle;
  const presets = (options.presets ?? resolvePresetRanges(chain)).map((range) => ({
    ...range,
    estimate: degraded
      ? { status: "unavailable" as const, reason: "degraded-data" as const }
      : estimateRangeApr(inputs, range),
  }));
  return {
    poolId,
    fetchedAt: new Date(nowSeconds * 1000).toISOString(),
    label: RANGE_APR_LABEL,
    assumptions: options.assumptions ?? RANGE_APR_ASSUMPTIONS,
    pool: {
      tickSpacing: chain.tickSpacing, tickCurrent: chain.tickCurrent, currentPrice: economics.price,
      decimalsA: chain.decimalsA, decimalsB: chain.decimalsB, feeRate: economics.feeRate,
      lpFeeFraction: fraction, tvlUsd: economics.tvlUsd,
    },
    model: { bins, currentSqrt, usdPerRawB, avgDailyVolumeUsd: volume.avgDailyVolumeUsd },
    sample: {
      days: volume.days, volumeSource: volume.source, ...(volume.protocol ? { volumeProtocol: volume.protocol } : {}), occupancySource,
      candleCount: windowCandles.length,
      unplacedVolumePct,
      confidence: sampleConfidence({
        days: volume.days, volumeSource: volume.source, occupancySource, unplacedVolumePct, candleCount: windowCandles.length,
      }),
      degraded,
      issues: idle ? [...profile.issues, "no trades in the sample window"] : profile.issues,
    },
    referenceCapitalUsd: RANGE_APR_REFERENCE_CAPITAL_USD,
    presets,
    sources: [...profile.sources, options.chainSource ?? SOLANA_CLMM_CHAIN_SOURCE],
    published: { dayFeeApr: economics.dayFeeApr, weekFeeApr: economics.weekFeeApr },
  };
}

export async function fetchPoolRangeApr(
  poolId: string, options: FetchPoolRangeAprOptions = {},
): Promise<PoolRangeAprPayload> {
  const fetcher = options.fetcher ?? fetch;
  const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const loadProfile = () => loadVolumeProfileResilient(poolId, fetcher, nowSeconds, { retry: options.retry, gate: options.gate });
  const loadChain = () => readOnchainPoolLiquidity(poolId, options.connection);
  const [profile, chain] = options.bypassCache
    ? await Promise.all([loadProfile(), loadChain()])
    : await Promise.all([volumeCache.get(poolId, loadProfile), chainCache.get(poolId, loadChain)]);
  return assemblePoolRangeApr(poolId, profile, chain, nowSeconds);
}

