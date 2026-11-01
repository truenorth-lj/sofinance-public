import "@/lib/engine-host";
import "server-only";
import { loadVolumeProfile, RAYDIUM_ECONOMICS_SOURCE } from "../pool-range-apr";
import { readOnchainPoolLiquidity } from "../range-apr/onchain-liquidity";
import { discoverRwaPairs } from "../rwa-pairs";
import { FEED_KEY } from "../rwa-store-types";
import { solanaIconSources } from "../token-icons/resolve";
import type { PoolSource } from "./types";

/**
 * Raydium CLMM, the first `PoolSource`: a thin wrapper over the existing scan (Raydium API v3 list + Jupiter /
 * xStocks qualification), GeckoTerminal price history on the run's gate, and Raydium tick arrays. Wrapping changes
 * nothing: every call passes its arguments through exactly as the cron passed them before.
 */
export const raydiumPoolSource: PoolSource = {
  id: "raydium-clmm",
  chain: "solana",
  feedKey: FEED_KEY,
  displayName: "Raydium",
  discover: (options) => discoverRwaPairs(options),
  economics: RAYDIUM_ECONOMICS_SOURCE,
  // No `economics` override: `loadVolumeProfile` defaults to Raydium, and the call stays byte-identical.
  loadProfile: (poolId, fetcher, nowSeconds, upstream) => loadVolumeProfile(poolId, fetcher, nowSeconds, upstream),
  readLiquidity: (poolId, connection) => readOnchainPoolLiquidity(poolId, connection),
  iconSources: (fetcher) => solanaIconSources(fetcher),
};
