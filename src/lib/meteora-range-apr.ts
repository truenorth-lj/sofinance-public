import "@/lib/engine-host";
import "server-only";

import type { Connection } from "@solana/web3.js";
import { meteoraBinArrayIndexesForRange } from "@sofinance/engine/protocols/meteora/accounts";
import { METEORA_ALLOWLISTED_POOLS, type MeteoraPoolSpec } from "@sofinance/engine/protocols/meteora/constants";
import { AsyncCache } from "./async-cache";
import { assemblePoolRangeApr, hasPriceHistory, loadVolumeProfileResilient, type FetchPoolRangeAprOptions, type VolumeProfile } from "./pool-range-apr";
import { VOLUME_WINDOW_DAYS } from "./range-apr/daily-volume";
import { datapiFeeCrossCheck, type PoolHistorySource } from "./range-apr/meteora-datapi-history";
import { meteoraEconomicsSource } from "./range-apr/meteora-economics";
import { feeFraction, readMeteoraPoolLiquidity, type MeteoraPoolLiquidity } from "./range-apr/meteora-liquidity";
import { RANGE_APR_PRESET_ORDER, resolvePresetRanges, type PresetTickRange } from "./range-apr/preset-ranges";
import { RANGE_APR_REFERENCE_CAPITAL_USD } from "./range-apr/range-apr";
import type { PoolRangeAprPayload, RangeAprPresetId } from "./range-apr/types";

/**
 * Read-only Meteora DLMM pool state, bin-array liquidity and ESTIMATED range APR: the same model and payload as
 * Raydium's `/api/pool-range-apr` (GeckoTerminal volume + hourly price path, preset ranges from
 * `resolveOpenRange`), with Meteora economics and liquidity from the LbPair bin arrays. Nothing here builds or
 * signs transactions.
 */

export const METEORA_RANGE_APR_LABEL = "Estimated fee APR";

/** Where the volume and hourly price history came from (wording only). */
export type MeteoraHistoryLabel = "GeckoTerminal" | "Meteora";

export const meteoraRangeAprAssumptions = (history: MeteoraHistoryLabel) => [
  `Estimate, not a guarantee. Back-tests the last ${VOLUME_WINDOW_DAYS} complete UTC days of pool volume (${history}, current day excluded) against the pool's liquidity right now (on-chain Meteora DLMM bin arrays).`,
  "Fees = volume that traded inside your range × the pool's base fee × the share LPs keep (Meteora keeps its on-chain protocol share) × your share of the liquidity in each bin, assuming an even (Spot) spread across the range.",
  "The variable (volatility) fee is left out, so busy periods can earn more than shown.",
  "Volume only counts while the price is inside your range, using hourly price history; time out of range earns nothing.",
  "Assumes volume, other LPs' liquidity and prices behave like the recent past. Excludes impermanent loss, rewards, swap and rent costs.",
  `Rate shown for a ~$${RANGE_APR_REFERENCE_CAPITAL_USD} deposit; larger deposits dilute their own share of the fees.`,
].join(" ");

export const METEORA_RANGE_APR_ASSUMPTIONS = meteoraRangeAprAssumptions("GeckoTerminal");

const METEORA_CHAIN_SOURCE = "Solana RPC: Meteora DLMM LbPair + bin arrays (reserves per bin)";

/** Inclusive DLMM bin range of a preset (the shared tick range is [tickLower, tickUpper)). */
export type MeteoraPresetBins = {
  id: RangeAprPresetId;
  lowerBinId: number;
  upperBinId: number;
  binCount: number;
  binArrayIndexes: number[];
  /** v1 opens only when every bin array of the range already exists (no non-refundable bin-array rent). */
  withinExistingBinArrays: boolean;
};

export type MeteoraRangeAprPayload = PoolRangeAprPayload & {
  protocol: "meteora-dlmm";
  readOnly: true;
  estimated: true;
  state: MeteoraPoolLiquidity["state"] & { sqrtPriceX64: string; mintX: string; mintY: string };
  presetBins: MeteoraPresetBins[];
  /** Datapi vs on-chain differences (the on-chain values are used). */
  dataNotes: string[];
};

export const isAllowlistedMeteoraPool = (poolId: string) => METEORA_ALLOWLISTED_POOLS.some((pool) => pool.poolAddress === poolId);

const volumeCache = new AsyncCache<VolumeProfile>({ ttlMs: 30 * 60_000, failureTtlMs: 15_000, ttlFor: (profile) => (!hasPriceHistory(profile) ? 45_000 : profile.stale ? 60_000 : 30 * 60_000) });
const chainCache = new AsyncCache<MeteoraPoolLiquidity>({ ttlMs: 30_000, failureTtlMs: 15_000 });

export function clearMeteoraRangeAprCache() {
  volumeCache.clear();
  chainCache.clear();
}

/**
 * The shared presets on the pool's bin grid (`resolvePresetRanges` with tick spacing = bin step, see `binTick`),
 * deduplicated by width: walking Micro → Wide, a preset as wide as the previous one replaces it (the wider id
 * wins) and a narrower one is dropped, so widths strictly increase. Bin step 1 keeps all four; at bin step 10
 * Tight (±0.05%) is narrower than Micro (±2 bins) and drops out.
 */
export function meteoraPresetRanges(chain: Pick<MeteoraPoolLiquidity, "tickCurrent" | "sqrtPriceX64" | "decimalsA" | "decimalsB" | "tickSpacing">): PresetTickRange[] {
  return dedupePresetsByWidth(resolvePresetRanges(chain));
}

export function dedupePresetsByWidth<T extends { id: RangeAprPresetId; tickLower: number; tickUpper: number }>(presets: readonly T[]): T[] {
  const ordered = [...presets].sort((a, b) => RANGE_APR_PRESET_ORDER.indexOf(a.id) - RANGE_APR_PRESET_ORDER.indexOf(b.id));
  const kept: T[] = [];
  for (const preset of ordered) {
    const last = kept.at(-1);
    const width = preset.tickUpper - preset.tickLower;
    if (!last || width > last.tickUpper - last.tickLower) kept.push(preset);
    else if (width === last.tickUpper - last.tickLower) kept[kept.length - 1] = preset;
  }
  return kept;
}

export function presetBins(
  presets: readonly { id: RangeAprPresetId; tickLower: number; tickUpper: number }[],
  existing: MeteoraPoolLiquidity["state"]["existingBinRange"],
  binStep = 1,
): MeteoraPresetBins[] {
  return presets.map(({ id, tickLower, tickUpper }) => {
    const lowerBinId = tickLower / binStep, upperBinId = tickUpper / binStep - 1;
    return {
      id, lowerBinId, upperBinId, binCount: upperBinId - lowerBinId + 1,
      binArrayIndexes: meteoraBinArrayIndexesForRange(lowerBinId, upperBinId),
      withinExistingBinArrays: existing !== null && lowerBinId >= existing.lowerBinId && upperBinId <= existing.upperBinId,
    };
  });
}

/** Pure: shared assembly with the on-chain fee config, plus Meteora wording, sources and the read-only state. */
export function assembleMeteoraRangeApr(
  poolId: string, profile: VolumeProfile, chain: MeteoraPoolLiquidity, nowSeconds: number,
  history: MeteoraHistoryLabel = "GeckoTerminal",
): MeteoraRangeAprPayload {
  const assumptions = meteoraRangeAprAssumptions(history);
  const { economics } = profile;
  const onchainFeeRate = feeFraction(chain.state.baseFeeRate);
  const onchainProtocolFeeRate = chain.state.protocolShare * 100; // bps → parts per million
  const dataNotes: string[] = [];
  if (Math.abs(economics.feeRate - onchainFeeRate) > 1e-12) {
    dataNotes.push(`base fee: datapi ${economics.feeRate}, on-chain ${onchainFeeRate}`);
  }
  if (economics.protocolFeeRate !== onchainProtocolFeeRate) {
    dataNotes.push(`protocol share: datapi ${(economics.protocolFeeRate ?? 0) / 10_000}%, on-chain ${chain.state.protocolShare / 100}%`);
  }
  if (profile.feeTotals) dataNotes.push(...datapiFeeCrossCheck(profile.feeTotals, onchainFeeRate, chain.state.protocolShare / 10_000));
  const onchainProfile: VolumeProfile = {
    ...profile,
    economics: { ...economics, feeRate: onchainFeeRate, protocolFeeRate: onchainProtocolFeeRate, fundFeeRate: 0 },
  };
  const payload = assemblePoolRangeApr(poolId, onchainProfile, chain, nowSeconds, {
    assumptions, chainSource: METEORA_CHAIN_SOURCE, presets: meteoraPresetRanges(chain),
  });
  return {
    ...payload,
    label: METEORA_RANGE_APR_LABEL,
    assumptions,
    protocol: "meteora-dlmm",
    readOnly: true,
    estimated: true,
    state: { ...chain.state, sqrtPriceX64: chain.sqrtPriceX64, mintX: chain.mintA, mintY: chain.mintB },
    presetBins: presetBins(payload.presets, chain.state.existingBinRange, chain.state.binStep),
    dataNotes,
  };
}

export type FetchMeteoraRangeAprOptions = Omit<FetchPoolRangeAprOptions, "connection"> & {
  connection?: Connection;
  /** A scan-found pool (not allowlisted): the id, X/Y mints and bin step it must match. */
  spec?: MeteoraPoolSpec;
  /** Volume + hourly price history from Meteora's datapi instead of GeckoTerminal (`meteoraDatapiHistory`). */
  history?: PoolHistorySource;
};

export async function fetchMeteoraRangeApr(poolId: string, options: FetchMeteoraRangeAprOptions = {}): Promise<MeteoraRangeAprPayload> {
  const { spec } = options;
  if (spec ? spec.poolAddress !== poolId : !isAllowlistedMeteoraPool(poolId)) throw new Error("Meteora pool is not allowlisted");
  const fetcher = options.fetcher ?? fetch;
  const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const loadProfile = () => loadVolumeProfileResilient(poolId, fetcher, nowSeconds, {
    retry: options.retry, gate: options.gate, economics: meteoraEconomicsSource(spec), history: options.history,
  });
  const loadChain = () => readMeteoraPoolLiquidity(poolId, options.connection, spec);
  // Scan-found pools and datapi history bypass the page caches (the cron reads each pool once per run).
  const [profile, chain] = options.bypassCache || spec || options.history
    ? await Promise.all([loadProfile(), loadChain()])
    : await Promise.all([volumeCache.get(poolId, loadProfile), chainCache.get(poolId, loadChain)]);
  return assembleMeteoraRangeApr(poolId, profile, chain, nowSeconds, options.history ? "Meteora" : "GeckoTerminal");
}
