import "@/lib/engine-host";
import "server-only";

import { CLMM_PROGRAM_ID, PoolInfoLayout, TickArrayLayout, getPdaTickArrayAddress } from "@raydium-io/raydium-sdk-v2";
import { PublicKey, type Connection } from "@solana/web3.js";
import { rpcConnection } from "@sofinance/engine/rpc";
import { buildLiquidityBins, tickArrayStartsForWindow, windowBounds, type LiquidityBin } from "./liquidity-bins";

/** Analysed price window: at least +-300 raw ticks (~3%) and at least +-6 bins on coarse pools. */
export const WINDOW_MIN_TICKS = 300;
export const WINDOW_MIN_BINS = 6;

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
  const pool = new PublicKey(poolId);
  const poolInfo = await connection.getAccountInfo(pool, "confirmed");
  if (!poolInfo || !poolInfo.owner.equals(CLMM_PROGRAM_ID)) {
    throw new Error("Raydium CLMM pool account does not exist");
  }
  const state = PoolInfoLayout.decode(poolInfo.data);
  const tickSpacing = state.tickSpacing;
  const half = halfWindowBinsFor(tickSpacing);
  const { firstTick, endTick } = windowBounds(state.tickCurrent, tickSpacing, half);
  const starts = tickArrayStartsForWindow(firstTick, endTick, tickSpacing);
  const keys = starts.map((start) => getPdaTickArrayAddress(CLMM_PROGRAM_ID, pool, start).publicKey);
  const infos = await connection.getMultipleAccountsInfo(keys, "confirmed");
  const liquidityNet = new Map<number, bigint>();
  infos.forEach((info, index) => {
    if (!info) return;
    if (!info.owner.equals(CLMM_PROGRAM_ID)) throw new Error("Tick array owner mismatch");
    const array = TickArrayLayout.decode(info.data);
    if (!array.poolId.equals(pool) || array.startTickIndex !== starts[index]) {
      throw new Error("Tick array pool or start index mismatch");
    }
    for (const tick of array.ticks) {
      if (tick.liquidityGross.isZero()) continue;
      liquidityNet.set(tick.tick, BigInt(tick.liquidityNet.toString()));
    }
  });
  return {
    poolId,
    mintA: state.mintA.toBase58(),
    mintB: state.mintB.toBase58(),
    decimalsA: state.mintDecimalsA,
    decimalsB: state.mintDecimalsB,
    tickSpacing,
    tickCurrent: state.tickCurrent,
    sqrtPriceX64: state.sqrtPriceX64.toString(),
    bins: buildLiquidityBins({
      tickCurrent: state.tickCurrent,
      tickSpacing,
      poolLiquidity: BigInt(state.liquidity.toString()),
      liquidityNet,
      halfWindowBins: half,
    }),
  };
}
