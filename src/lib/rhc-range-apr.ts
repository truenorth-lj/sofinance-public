import "@/lib/engine-host";
import "server-only";

import type { Hex, PublicClient } from "viem";
import { UNIV4_RHC_ALLOWLISTED_POOLS, type Univ4AllowlistedPool } from "@sofinance/engine/protocols/uniswap-v4/constants";
import { readPoolState } from "@sofinance/engine/protocols/uniswap-v4/discovery";
import { readTickWindow } from "@sofinance/engine/protocols/uniswap-v4/open-chain";
import { fetchUniv4MarketData } from "@sofinance/engine/protocols/uniswap-v4/market-data";
import { createRhcClient } from "@sofinance/engine/rpc-evm/index";
import { AsyncCache } from "./async-cache";
import {
  assemblePoolRangeApr, hasPriceHistory, loadVolumeProfileResilient, type FetchPoolRangeAprOptions,
  type LoadedPoolEconomicsSource, type VolumeProfile,
} from "./pool-range-apr";
import { geckoGate } from "./pool-metrics/gecko";
import { buildLiquidityBins, type LiquidityBin } from "./range-apr/liquidity-bins";
import { halfWindowBinsFor, type OnchainPoolLiquidity } from "./range-apr/onchain-liquidity";
import type { PoolEconomics } from "./range-apr/raydium-economics";
import type { PoolRangeAprPayload } from "./range-apr/types";
import { VOLUME_WINDOW_DAYS } from "./range-apr/daily-volume";
import { RANGE_APR_REFERENCE_CAPITAL_USD } from "./range-apr/range-apr";
import { poolFeeAprPct } from "@sofinance/engine/fee-apr";
import { takeGeckoTerminalSlot } from "./rhc-univ4-pools";
import { isRhcApr7dEnabled } from "./protocol-flags";
import { resolveRhcPresetRanges, sqrtPriceX96ToX64 } from "./rhc-range-apr-presets";
export { resolveRhcPresetRanges, sqrtPriceX96ToX64 } from "./rhc-range-apr-presets";

/**
 * Uniswap v4 on Robinhood Chain: 7-day range APR through the shared Solana pipeline (PM/LJ 2026-10-30 D3).
 * Economics = current hook fee (D7) + indexer TVL; liquidity = StateView tick window (X96→X64); presets =
 * ±10 ticks / ±0.3% / ±1%. Behind `RHC_APR7D_ENABLED`.
 */

export const RHC_RANGE_APR_ASSUMPTIONS = [
  `Estimate, not a guarantee. Back-tests the last ${VOLUME_WINDOW_DAYS} complete UTC days of pool volume (GeckoTerminal, current day excluded) against the pool's liquidity right now (StateView tick bitmap).`,
  "Fees = volume that traded inside your range × the StablePairHook's current fee rate × your share of the liquidity in each price bin. The hook fee is dynamic; this uses the live value (same as the 24h estimate).",
  "Volume only counts while the price is inside your range, using hourly price history; time out of range earns nothing.",
  "Assumes volume, other LPs' liquidity and prices behave like the recent past. Excludes impermanent loss, rewards and gas.",
  `Rate shown for a ~$${RANGE_APR_REFERENCE_CAPITAL_USD} deposit; larger deposits dilute their own share of the fees.`,
].join(" ");

export const RHC_CHAIN_SOURCE = "Robinhood Chain RPC: StateView slot0 + tick bitmap/liquidity (X96→X64)";

const ECONOMICS_TTL_MS = 30 * 60_000;
const CHAIN_TTL_MS = 30_000;
const FAILURE_TTL_MS = 15_000;
const DEGRADED_TTL_MS = 45_000;
const STALE_TTL_MS = 60_000;

const profileTtl = (profile: VolumeProfile) =>
  !hasPriceHistory(profile) ? DEGRADED_TTL_MS : profile.stale ? STALE_TTL_MS : ECONOMICS_TTL_MS;

const volumeCache = new AsyncCache<VolumeProfile>({ ttlMs: ECONOMICS_TTL_MS, failureTtlMs: FAILURE_TTL_MS, ttlFor: profileTtl });
const chainCache = new AsyncCache<OnchainPoolLiquidity>({ ttlMs: CHAIN_TTL_MS, failureTtlMs: FAILURE_TTL_MS });

let stateClient: PublicClient | null = null;
const client = () => (stateClient ??= createRhcClient("state"));

export function isAllowlistedRhcPool(poolId: string): boolean {
  return UNIV4_RHC_ALLOWLISTED_POOLS.some((p) => p.poolId.toLowerCase() === poolId.toLowerCase());
}

export function rhcPoolSpec(poolId: string): Univ4AllowlistedPool | null {
  return UNIV4_RHC_ALLOWLISTED_POOLS.find((p) => p.poolId.toLowerCase() === poolId.toLowerCase()) ?? null;
}

async function loadRhcEconomics(poolId: string, fetcher: typeof fetch): Promise<PoolEconomics | null> {
  const spec = rhcPoolSpec(poolId);
  if (!spec) return null;
  const [state, market] = await Promise.all([
    readPoolState(client(), spec),
    fetchUniv4MarketData(spec, {
      fetcher,
      allowFallback: () => takeGeckoTerminalSlot(),
      onUpstream: (event) => {
        if (event.source === "geckoterminal" && event.outcome === "rate-limited") geckoGate.block();
      },
    }),
  ]);
  if (!state.dynamicFee || !state.slot0 || !market) return null;
  const feePips = (state.dynamicFee.zeroForOne + state.dynamicFee.oneForZero) / 2;
  const feeRate = feePips / 1_000_000;
  const decimals0 = spec.currency0.decimals, decimals1 = spec.currency1.decimals;
  const price = state.slot0.sqrtPriceX96 > 0n
    ? Math.pow(Number(state.slot0.sqrtPriceX96) / 2 ** 96, 2) * 10 ** (decimals0 - decimals1)
    : 1;
  // Indexers report USD TVL; approximate token amounts so usdPerRawTokenB can recover a USD-per-raw-B.
  const halfTvl = market.tvlUsd / 2;
  const mintAmountA = price > 0 ? halfTvl / price : 0;
  const mintAmountB = halfTvl;
  return {
    mintA: spec.currency0.address, mintB: spec.currency1.address,
    decimalsA: decimals0, decimalsB: decimals1,
    feeRate, tvlUsd: market.tvlUsd, price, mintAmountA, mintAmountB,
    protocolFeeRate: state.slot0.protocolFee === 0 ? 0 : null,
    fundFeeRate: 0,
    weekVolumeUsd: null,
    dayFeeApr: null, weekFeeApr: null,
  };
}

export const RHC_ECONOMICS_SOURCE: LoadedPoolEconomicsSource = {
  name: "Uniswap v4 (RHC)",
  protocol: "uniswap-v4-rhc",
  source: "Robinhood Chain RPC: StablePairHook getFee + DexScreener/GeckoTerminal TVL",
  load: loadRhcEconomics,
};

export async function readRhcPoolLiquidity(poolId: string, publicClient: PublicClient = client()): Promise<OnchainPoolLiquidity> {
  const spec = rhcPoolSpec(poolId);
  if (!spec) throw new Error("RHC pool is not allowlisted");
  const state = await readPoolState(publicClient, spec);
  if (!state.slot0 || state.liquidity === null) throw new Error("RHC pool state unavailable");
  const half = halfWindowBinsFor(spec.tickSpacing);
  const { liquidityNet } = await readTickWindow(publicClient, spec, state.slot0.tick);
  const bins: LiquidityBin[] = buildLiquidityBins({
    tickCurrent: state.slot0.tick,
    tickSpacing: spec.tickSpacing,
    poolLiquidity: state.liquidity,
    liquidityNet,
    halfWindowBins: half,
  });
  return {
    poolId: spec.poolId,
    mintA: spec.currency0.address, mintB: spec.currency1.address,
    decimalsA: spec.currency0.decimals, decimalsB: spec.currency1.decimals,
    tickSpacing: spec.tickSpacing, tickCurrent: state.slot0.tick,
    sqrtPriceX64: sqrtPriceX96ToX64(state.slot0.sqrtPriceX96),
    bins,
  };
}

export type RhcRangeAprPayload = PoolRangeAprPayload & {
  protocol: "uniswap-v4-rhc";
  readOnly: true;
  /** Whole-pool 7d APR (hook fee × avg daily vol / TVL × 365); secondary to the range headline. */
  poolFeeApr7dPct: number | null;
};

export function assembleRhcRangeApr(
  poolId: string, profile: VolumeProfile, chain: OnchainPoolLiquidity, nowSeconds: number,
): RhcRangeAprPayload {
  const presets = resolveRhcPresetRanges(chain);
  const payload = assemblePoolRangeApr(poolId, profile, chain, nowSeconds, {
    assumptions: RHC_RANGE_APR_ASSUMPTIONS, chainSource: RHC_CHAIN_SOURCE, presets,
  });
  const feeRate = profile.economics.feeRate;
  const avg = payload.model.avgDailyVolumeUsd;
  const tvl = profile.economics.tvlUsd;
  const poolFeeApr7dPct = poolFeeAprPct({ feeRate, dailyVolumeUsd: avg, tvlUsd: tvl });
  return { ...payload, protocol: "uniswap-v4-rhc", readOnly: true, poolFeeApr7dPct };
}

export type FetchRhcRangeAprOptions = Omit<FetchPoolRangeAprOptions, "connection"> & { client?: PublicClient };

export async function fetchRhcRangeApr(poolId: string, options: FetchRhcRangeAprOptions = {}): Promise<RhcRangeAprPayload> {
  if (!isRhcApr7dEnabled()) throw new Error("RHC 7-day APR is disabled");
  if (!isAllowlistedRhcPool(poolId)) throw new Error("RHC pool is not allowlisted");
  const fetcher = options.fetcher ?? fetch;
  const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const loadProfile = () => loadVolumeProfileResilient(poolId, fetcher, nowSeconds, {
    retry: options.retry, gate: options.gate ?? geckoGate,
    economics: RHC_ECONOMICS_SOURCE, network: "robinhood",
  });
  const loadChain = () => readRhcPoolLiquidity(poolId, options.client);
  const [profile, chain] = options.bypassCache
    ? await Promise.all([loadProfile(), loadChain()])
    : await Promise.all([volumeCache.get(poolId, loadProfile), chainCache.get(poolId, loadChain)]);
  return assembleRhcRangeApr(poolId, profile, chain, nowSeconds);
}

export function clearRhcRangeAprCache(): void {
  volumeCache.clear();
  chainCache.clear();
  stateClient = null;
}

/** Allowlisted pool ids (lowercase) for the cron / registry. */
export function rhcAprPoolIds(): readonly Hex[] {
  return UNIV4_RHC_ALLOWLISTED_POOLS.map((p) => p.poolId);
}
