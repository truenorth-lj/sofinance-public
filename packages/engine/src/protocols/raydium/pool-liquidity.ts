import { CLMM_PROGRAM_ID, getPdaTickArrayAddress, PoolInfoLayout, TickArrayLayout } from "@raydium-io/raydium-sdk-v2";
import { Connection, PublicKey } from "@solana/web3.js";

/** No account, or another program owns it. The app maps this to its public "not tracked" answer. */
export class RaydiumPoolAccountMissingError extends Error {
  constructor() {
    super("Raydium CLMM pool account does not exist");
    this.name = "RaydiumPoolAccountMissingError";
  }
}

export type RaydiumLiquiditySample = {
  mintA: string;
  mintB: string;
  decimalsA: number;
  decimalsB: number;
  tickSpacing: number;
  tickCurrent: number;
  sqrtPriceX64: string;
  poolLiquidity: bigint;
  /** Initialised ticks only. Missing tick arrays contribute nothing. */
  liquidityNet: ReadonlyMap<number, bigint>;
};

/**
 * Pool account plus the tick arrays covering `tickArrayStarts(pool)`.
 * The caller chooses the window; this function only reads and checks the accounts.
 */
export async function readRaydiumLiquiditySample(
  poolId: string,
  connection: Connection,
  tickArrayStarts: (pool: { tickSpacing: number; tickCurrent: number }) => readonly number[],
): Promise<RaydiumLiquiditySample> {
  const pool = new PublicKey(poolId);
  const poolInfo = await connection.getAccountInfo(pool, "confirmed");
  if (!poolInfo || !poolInfo.owner.equals(CLMM_PROGRAM_ID)) throw new RaydiumPoolAccountMissingError();
  const state = PoolInfoLayout.decode(poolInfo.data);
  const starts = tickArrayStarts({ tickSpacing: state.tickSpacing, tickCurrent: state.tickCurrent });
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
    mintA: state.mintA.toBase58(),
    mintB: state.mintB.toBase58(),
    decimalsA: state.mintDecimalsA,
    decimalsB: state.mintDecimalsB,
    tickSpacing: state.tickSpacing,
    tickCurrent: state.tickCurrent,
    sqrtPriceX64: state.sqrtPriceX64.toString(),
    poolLiquidity: BigInt(state.liquidity.toString()),
    liquidityNet,
  };
}
