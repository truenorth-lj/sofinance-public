import type { Univ4PoolApr } from "@sofinance/engine/protocols/uniswap-v4/market-data";

/** Pool data the RHC open panel renders. Lives in lib so `lib/unified-pools/rows.ts` does not import a UI component. */
export type RhcPoolView = {
  poolId: string;
  status: "listed" | "delisted";
  tick: number | null;
  price: number | null;
  token0: { address: string; symbol: string; decimals: number };
  token1: { address: string; symbol: string; decimals: number };
  estimatedApr: Univ4PoolApr | null;
};
