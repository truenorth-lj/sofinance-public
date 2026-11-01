import "@/lib/engine-host";
import "server-only";
import type { MeteoraPoolSpec } from "@sofinance/engine/protocols/meteora/constants";
import { assembleMeteoraRangeApr, meteoraPresetRanges } from "../meteora-range-apr";
import { discoverMeteoraRwaPairs } from "../meteora-rwa-scan";
import { loadVolumeProfile } from "../pool-range-apr";
import { meteoraDatapiHistory, MeteoraDatapiError } from "../range-apr/meteora-datapi-history";
import { meteoraEconomicsSource } from "../range-apr/meteora-economics";
import { readMeteoraPoolLiquidity, type MeteoraPoolLiquidity } from "../range-apr/meteora-liquidity";
import { FEED_KEY_METEORA } from "../rwa-store-types";
import { solanaIconSources } from "../token-icons/resolve";
import type { PoolPairRef, PoolSource } from "./types";

/**
 * The spec a stored Meteora pool is read with: its id, X/Y mints (mintA = X, mintB = Y, as discovery wrote them)
 * and bin step. Throws when the stored row has no bin step (a row this lane must not guess for).
 */
export function meteoraSpecOf(poolId: string, pair: PoolPairRef | undefined): MeteoraPoolSpec {
  if (!pair || pair.poolAddress !== poolId || !Number.isInteger(pair.binStep) || pair.binStep! < 1) {
    throw new Error("Meteora pool row has no bin step");
  }
  return { poolAddress: poolId, mintX: pair.mintA, mintY: pair.mintB, binStep: pair.binStep! };
}

/**
 * Meteora DLMM pools of the scan feed: economics, 7 days of volume and the hourly price path from Meteora's datapi
 * (never GeckoTerminal, so these pools do not use the cron's GeckoTerminal budget), bin arrays on chain, and the
 * Meteora assembly (on-chain base fee and protocol share, per-bin-step presets, datapi fee cross-check).
 */
export const meteoraPoolSource: PoolSource = {
  id: "meteora-dlmm",
  chain: "solana",
  feedKey: FEED_KEY_METEORA,
  displayName: "Meteora",
  discover: (options) => discoverMeteoraRwaPairs(options),
  economics: meteoraEconomicsSource(),
  loadProfile: (poolId, fetcher, nowSeconds, upstream) => {
    const spec = meteoraSpecOf(poolId, upstream.pair);
    const createdAtMs = upstream.pair?.poolCreatedAt ? Date.parse(upstream.pair.poolCreatedAt) : NaN;
    return loadVolumeProfile(poolId, fetcher, nowSeconds, {
      retry: upstream.retry,
      economics: meteoraEconomicsSource(spec),
      history: meteoraDatapiHistory({
        mintX: spec.mintX, mintY: spec.mintY,
        ...(Number.isFinite(createdAtMs) ? { createdAtSeconds: Math.floor(createdAtMs / 1000) } : {}),
      }),
    });
  },
  readLiquidity: (poolId, connection, pair) => readMeteoraPoolLiquidity(poolId, connection, meteoraSpecOf(poolId, pair)),
  presets: (chain) => meteoraPresetRanges(chain as MeteoraPoolLiquidity),
  assemble: (poolId, profile, chain, nowSeconds) => assembleMeteoraRangeApr(poolId, profile, chain as MeteoraPoolLiquidity, nowSeconds, "Meteora"),
  isThrottleError: (error) => error instanceof MeteoraDatapiError && error.code === "datapi-429",
  iconSources: (fetcher) => solanaIconSources(fetcher),
};
