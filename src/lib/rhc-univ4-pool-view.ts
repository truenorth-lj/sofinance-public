import "server-only";
import { UNIV4_RHC_ALLOWLISTED_POOLS } from "@sofinance/engine/protocols/uniswap-v4/constants";
import type { RhcPoolView } from "@/components/rhc-univ4-open-panel";
import { discoverRhcUniv4Pools } from "@/lib/rhc-univ4-pools";

/** Pool data for the `/app/rhc` page: the allowlisted SPCX/SPCXon pool, or null when discovery is unavailable. */
export async function loadRhcPoolView(): Promise<RhcPoolView | null> {
  const spec = UNIV4_RHC_ALLOWLISTED_POOLS[0]!;
  const result = await discoverRhcUniv4Pools().catch(() => null);
  const summary = result?.pools.find(p => p.poolId.toLowerCase() === spec.poolId.toLowerCase());
  if (!summary) return null;
  return {
    poolId: spec.poolId, status: summary.status, tick: summary.tick, price: summary.price, estimatedApr: summary.estimatedApr,
    token0: { address: spec.currency0.address, symbol: spec.currency0.symbol, decimals: spec.currency0.decimals },
    token1: { address: spec.currency1.address, symbol: spec.currency1.symbol, decimals: spec.currency1.decimals },
  };
}

