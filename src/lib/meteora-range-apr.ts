import "@/lib/engine-host";
import "server-only";

import type { Connection } from "@solana/web3.js";
import { meteoraBinArrayIndexesForRange } from "@sofinance/engine/protocols/meteora/accounts";
import { METEORA_ALLOWLISTED_POOLS } from "@sofinance/engine/protocols/meteora/constants";
import { AsyncCache } from "./async-cache";
import { assemblePoolRangeApr, hasPriceHistory, loadVolumeProfileResilient, type FetchPoolRangeAprOptions, type VolumeProfile } from "./pool-range-apr";
import { VOLUME_WINDOW_DAYS } from "./range-apr/daily-volume";
import { METEORA_ECONOMICS_SOURCE } from "./range-apr/meteora-economics";
import { feeFraction, readMeteoraPoolLiquidity, type MeteoraPoolLiquidity } from "./range-apr/meteora-liquidity";
import { RANGE_APR_REFERENCE_CAPITAL_USD } from "./range-apr/range-apr";
import type { PoolRangeAprPayload, RangeAprPresetId } from "./range-apr/types";

/**
 * Read-only Meteora DLMM pool state, bin-array liquidity and ESTIMATED range APR: the same model and payload as
 * Raydium's `/api/pool-range-apr` (GeckoTerminal volume + hourly price path, preset ranges from
 * `resolveOpenRange`), with Meteora economics and liquidity from the LbPair bin arrays. Nothing here builds or
 * signs transactions.
 */

export const METEORA_RANGE_APR_LABEL = "Estimated fee APR";

export const METEORA_RANGE_APR_ASSUMPTIONS = [
  `Estimate, not a guarantee. Back-tests the last ${VOLUME_WINDOW_DAYS} complete UTC days of pool volume (GeckoTerminal, current day excluded) against the pool's liquidity right now (on-chain Meteora DLMM bin arrays).`,
  "Fees = volume that traded inside your range × the pool's base fee × the share LPs keep (Meteora keeps its on-chain protocol share) × your share of the liquidity in each bin, assuming an even (Spot) spread across the range.",
  "The variable (volatility) fee is left out, so busy periods can earn more than shown.",
  "Volume only counts while the price is inside your range, using hourly price history; time out of range earns nothing.",
  "Assumes volume, other LPs' liquidity and prices behave like the recent past. Excludes impermanent loss, rewards, swap and rent costs.",
  `Rate shown for a ~$${RANGE_APR_REFERENCE_CAPITAL_USD} deposit; larger deposits dilute their own share of the fees.`,
].join(" ");

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

export function presetBins(
  presets: readonly { id: RangeAprPresetId; tickLower: number; tickUpper: number }[],
  existing: MeteoraPoolLiquidity["state"]["existingBinRange"],
): MeteoraPresetBins[] {
  return presets.map(({ id, tickLower, tickUpper }) => {
    const lowerBinId = tickLower, upperBinId = tickUpper - 1;
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
): MeteoraRangeAprPayload {
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
  const onchainProfile: VolumeProfile = {
    ...profile,
    economics: { ...economics, feeRate: onchainFeeRate, protocolFeeRate: onchainProtocolFeeRate, fundFeeRate: 0 },
  };
  const payload = assemblePoolRangeApr(poolId, onchainProfile, chain, nowSeconds, { assumptions: METEORA_RANGE_APR_ASSUMPTIONS, chainSource: METEORA_CHAIN_SOURCE });
  return {
    ...payload,
    label: METEORA_RANGE_APR_LABEL,
    assumptions: METEORA_RANGE_APR_ASSUMPTIONS,
    protocol: "meteora-dlmm",
    readOnly: true,
    estimated: true,
    state: { ...chain.state, sqrtPriceX64: chain.sqrtPriceX64, mintX: chain.mintA, mintY: chain.mintB },
    presetBins: presetBins(payload.presets, chain.state.existingBinRange),
    dataNotes,
  };
}

export type FetchMeteoraRangeAprOptions = Omit<FetchPoolRangeAprOptions, "connection"> & { connection?: Connection };

export async function fetchMeteoraRangeApr(poolId: string, options: FetchMeteoraRangeAprOptions = {}): Promise<MeteoraRangeAprPayload> {
  if (!isAllowlistedMeteoraPool(poolId)) throw new Error("Meteora pool is not allowlisted");
  const fetcher = options.fetcher ?? fetch;
  const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const loadProfile = () => loadVolumeProfileResilient(poolId, fetcher, nowSeconds, {
    retry: options.retry, gate: options.gate, economics: METEORA_ECONOMICS_SOURCE,
  });
  const loadChain = () => readMeteoraPoolLiquidity(poolId, options.connection);
  const [profile, chain] = options.bypassCache
    ? await Promise.all([loadProfile(), loadChain()])
    : await Promise.all([volumeCache.get(poolId, loadProfile), chainCache.get(poolId, loadChain)]);
  return assembleMeteoraRangeApr(poolId, profile, chain, nowSeconds);
}
