import "@/lib/engine-host";
import "server-only";

import { RaydiumPoolAccountMissingError, readRaydiumLiquiditySample } from "@sofinance/engine/protocols/raydium/pool-liquidity";
import { rpcConnection } from "@sofinance/engine/rpc";
import type { Connection } from "@solana/web3.js";
import { buildLiquidityBins, tickArrayStartsForWindow, windowBounds, type LiquidityBin } from "./liquidity-bins";
import { NotRaydiumClmmPoolError } from "./not-clmm-pool";

/** Analysed price window: at least +-300 raw ticks (~3%) and at least +-6 bins on coarse pools. */
const WINDOW_MIN_TICKS = 300;
const WINDOW_MIN_BINS = 6;

export function halfWindowBinsFor(tickSpacing: number): number {
  return Math.max(WINDOW_MIN_BINS, Math.ceil(WINDOW_MIN_TICKS / tickSpacing));
}

export type OnchainPoolLiquidity = {
  poolId: string;
  mintA: string;
  mintB: string;
  decimalsA: number;
  decimalsB: number;
  tickSpacing: number;
  tickCurrent: number;
  sqrtPriceX64: string;
  bins: LiquidityBin[];
};

/**
 * One pool account read + one batched read of the tick arrays that cover the analysed window, through
 * the shared RPC layer. Tick arrays that do not exist simply have no initialised ticks.
 */
export async function readOnchainPoolLiquidity(
  poolId: string, connection: Connection = rpcConnection(),
): Promise<OnchainPoolLiquidity> {
  let sample;
  try {
    sample = await readRaydiumLiquiditySample(poolId, connection, (pool) => {
      const half = halfWindowBinsFor(pool.tickSpacing);
      const { firstTick, endTick } = windowBounds(pool.tickCurrent, pool.tickSpacing, half);
      return tickArrayStartsForWindow(firstTick, endTick, pool.tickSpacing);
    });
  } catch (error) {
    if (error instanceof RaydiumPoolAccountMissingError) throw new NotRaydiumClmmPoolError();
    throw error;
  }
  const half = halfWindowBinsFor(sample.tickSpacing);
  return {
    poolId,
    mintA: sample.mintA,
    mintB: sample.mintB,
    decimalsA: sample.decimalsA,
    decimalsB: sample.decimalsB,
    tickSpacing: sample.tickSpacing,
    tickCurrent: sample.tickCurrent,
    sqrtPriceX64: sample.sqrtPriceX64,
    bins: buildLiquidityBins({
      tickCurrent: sample.tickCurrent,
      tickSpacing: sample.tickSpacing,
      poolLiquidity: sample.poolLiquidity,
      liquidityNet: sample.liquidityNet,
      halfWindowBins: half,
    }),
  };
}
