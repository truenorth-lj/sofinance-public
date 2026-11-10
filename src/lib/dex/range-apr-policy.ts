import type { DexId } from "./types";

/** Pure card/form policy: size-fit checks model Raydium's constant-liquidity prepare only. */
export function enforcesRangeAprSizeFit(dexId: DexId): boolean {
  return dexId === "raydium-clmm";
}
