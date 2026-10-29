import "@/lib/engine-host";
import "server-only";

import type { Connection } from "@solana/web3.js";
import { ORCA_ALLOWLISTED_POOLS } from "@sofinance/engine/protocols/orca/constants";
import { AsyncCache } from "./async-cache";
import { assemblePoolRangeApr, hasPriceHistory, loadVolumeProfileResilient, type FetchPoolRangeAprOptions, type VolumeProfile } from "./pool-range-apr";
import { VOLUME_WINDOW_DAYS } from "./range-apr/daily-volume";
import { ORCA_ECONOMICS_SOURCE } from "./range-apr/orca-economics";
import { readOrcaPoolLiquidity, type OrcaPoolLiquidity } from "./range-apr/orca-liquidity";
import { RANGE_APR_REFERENCE_CAPITAL_USD } from "./range-apr/range-apr";
import type { PoolRangeAprPayload } from "./range-apr/types";

/**
 * Read-only Orca Whirlpool range APR: the SAME model and payload as Raydium's `/api/pool-range-apr`
 * (GeckoTerminal volume + hourly price path, preset ranges from `resolveOpenRange`), with Orca economics
 * (Orca API v2) and liquidity from Whirlpool tick arrays. Nothing here builds or signs transactions.
 */

export const ORCA_RANGE_APR_ASSUMPTIONS = [
  `Estimate, not a guarantee. Back-tests the last ${VOLUME_WINDOW_DAYS} complete UTC days of pool volume (GeckoTerminal, current day excluded) against the pool's liquidity right now (on-chain Whirlpool tick arrays).`,
  "Fees = volume that traded inside your range × pool fee rate × the share LPs keep (Orca keeps its protocol fee, 13% on this pool) × your share of the liquidity in each price bin.",
  "Volume only counts while the price is inside your range, using hourly price history; time out of range earns nothing.",
  "Assumes volume, other LPs' liquidity and prices behave like the recent past. Excludes impermanent loss, rewards, swap and rent costs.",
  `Rate shown for a ~$${RANGE_APR_REFERENCE_CAPITAL_USD} deposit; larger deposits dilute their own share of the fees.`,
].join(" ");

const ORCA_CHAIN_SOURCE = "Solana RPC: Whirlpool account + tick arrays (liquidity per price bin)";

export type OrcaRangeAprPayload = PoolRangeAprPayload & {
  protocol: "orca-whirlpool";
  readOnly: true;
  state: OrcaPoolLiquidity["state"] & { sqrtPriceX64: string; mintA: string; mintB: string };
};

export const isAllowlistedOrcaPool = (poolId: string) => ORCA_ALLOWLISTED_POOLS.some((pool) => pool.poolAddress === poolId);

const volumeCache = new AsyncCache<VolumeProfile>({ ttlMs: 30 * 60_000, failureTtlMs: 15_000, ttlFor: (profile) => (!hasPriceHistory(profile) ? 45_000 : profile.stale ? 60_000 : 30 * 60_000) });
const chainCache = new AsyncCache<OrcaPoolLiquidity>({ ttlMs: 30_000, failureTtlMs: 15_000 });

export function clearOrcaRangeAprCache() {
  volumeCache.clear();
  chainCache.clear();
}

/** Pure: shared assembly plus Orca wording, sources and the read-only pool state. */
export function assembleOrcaRangeApr(
  poolId: string, profile: VolumeProfile, chain: OrcaPoolLiquidity, nowSeconds: number,
): OrcaRangeAprPayload {
  const payload = assemblePoolRangeApr(poolId, profile, chain, nowSeconds);
  return {
    ...payload,
    assumptions: ORCA_RANGE_APR_ASSUMPTIONS,
    sources: [...profile.sources, ORCA_CHAIN_SOURCE],
    protocol: "orca-whirlpool",
    readOnly: true,
    state: { ...chain.state, sqrtPriceX64: chain.sqrtPriceX64, mintA: chain.mintA, mintB: chain.mintB },
  };
}

export type FetchOrcaRangeAprOptions = Omit<FetchPoolRangeAprOptions, "connection"> & { connection?: Connection };

export async function fetchOrcaRangeApr(poolId: string, options: FetchOrcaRangeAprOptions = {}): Promise<OrcaRangeAprPayload> {
  if (!isAllowlistedOrcaPool(poolId)) throw new Error("Orca pool is not allowlisted");
  const fetcher = options.fetcher ?? fetch;
  const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const loadProfile = () => loadVolumeProfileResilient(poolId, fetcher, nowSeconds, {
    retry: options.retry, gate: options.gate, economics: ORCA_ECONOMICS_SOURCE,
  });
  const loadChain = () => readOrcaPoolLiquidity(poolId, options.connection);
  const [profile, chain] = options.bypassCache
    ? await Promise.all([loadProfile(), loadChain()])
    : await Promise.all([volumeCache.get(poolId, loadProfile), chainCache.get(poolId, loadChain)]);
  return assembleOrcaRangeApr(poolId, profile, chain, nowSeconds);
}
