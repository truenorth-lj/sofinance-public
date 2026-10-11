import "server-only";

import { AsyncCache } from "./async-cache";
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

export type VolumeProfile = {
  economics: RaydiumPoolEconomics;
  daily: { avgDailyVolumeUsd: number; days: number } | null;
  candles: RawCandle[] | null;
  sources: string[];
};

const volumeCache = new AsyncCache<VolumeProfile>({ ttlMs: ECONOMICS_TTL_MS, failureTtlMs: FAILURE_TTL_MS });
const chainCache = new AsyncCache<OnchainPoolLiquidity>({ ttlMs: CHAIN_TTL_MS, failureTtlMs: FAILURE_TTL_MS });

export function clearPoolRangeAprCache() {
  volumeCache.clear();
  chainCache.clear();
}

export type FetchPoolRangeAprOptions = {
  fetcher?: typeof fetch;
  connection?: Connection;
  nowSeconds?: number;
  bypassCache?: boolean;
};

export async function loadVolumeProfile(poolId: string, fetcher: typeof fetch, nowSeconds: number): Promise<VolumeProfile> {
  const id = encodeURIComponent(poolId);
  const [ids, daily, hourly] = await Promise.all([
    safeJson(fetcher, `${RAYDIUM_POOL_IDS}?ids=${id}`, 20_000),
    safeJson(fetcher, `${GECKO_TERMINAL_OHLCV}/${id}/ohlcv/day?aggregate=1&limit=30&currency=usd`, 20_000),
    safeJson(fetcher, `${GECKO_TERMINAL_OHLCV}/${id}/ohlcv/hour?aggregate=1&limit=200&currency=token`, 20_000),
  ]);
  const economics = ids.ok ? parseRaydiumPoolEconomics(ids.body) : null;
  if (!economics) throw new Error("Pool economics unavailable from Raydium");
  const sources = [`${RAYDIUM_POOL_IDS} (feeRate, TVL, token amounts, fee cuts)`];
  const dailySample = daily.ok ? averageDailyVolume(parseGeckoDailyVolumes(daily.body), nowSeconds) : null;
  if (dailySample) sources.push(`${GECKO_TERMINAL_OHLCV}/{pool}/ohlcv/day (USD volume)`);
  let candles: RawCandle[] | null = null;
  if (hourly.ok) {
    candles = orientCandles(parseGeckoHourlyCandles(hourly.body), economics.mintA, economics.mintB);
    if (candles) sources.push(`${GECKO_TERMINAL_OHLCV}/{pool}/ohlcv/hour (price path, token currency)`);
  }
  return { economics, daily: dailySample, candles, sources };
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
  const presets = resolvePresetRanges(chain).map((range) => ({
    ...range,
    estimate: estimateRangeApr(inputs, range),
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
  const loadProfile = () => loadVolumeProfile(poolId, fetcher, nowSeconds);
  const loadChain = () => readOnchainPoolLiquidity(poolId, options.connection);
  const [profile, chain] = options.bypassCache
    ? await Promise.all([loadProfile(), loadChain()])
    : await Promise.all([volumeCache.get(poolId, loadProfile), chainCache.get(poolId, loadChain)]);
  return assemblePoolRangeApr(poolId, profile, chain, nowSeconds);
}

