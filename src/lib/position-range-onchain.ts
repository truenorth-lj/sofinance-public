import "server-only";

import {
  CLMM_PROGRAM_ID,
  getPdaPersonalPositionAddress,
  PersonalPositionLayout,
  PoolInfoLayout,
  TickUtil,
} from "@raydium-io/raydium-sdk-v2";
import { Connection, PublicKey } from "@solana/web3.js";
import { createHash } from "node:crypto";
import { rpcConnection } from "./rpc";

const POSITION_DISCRIMINATOR = createHash("sha256").update("account:PersonalPositionState").digest().subarray(0, 8);
const POOL_DISCRIMINATOR = createHash("sha256").update("account:PoolState").digest().subarray(0, 8);

export type PositionRangeFacts = {
  positionMint: string;
  poolId: string;
  mintA: string;
  mintB: string;
  decimalsA: number;
  decimalsB: number;
  tickLower: number;
  tickUpper: number;
  tickCurrent: number;
  onChainPriceBPerA: number;
};

export async function readPositionRangeFacts(
  positionMint: string,
  connection: Connection = rpcConnection(),
): Promise<PositionRangeFacts> {
  const mint = new PublicKey(positionMint);
  const positionPda = getPdaPersonalPositionAddress(CLMM_PROGRAM_ID, mint).publicKey;
  const positionInfo = await connection.getAccountInfo(positionPda, "confirmed");
  if (
    !positionInfo ||
    !positionInfo.owner.equals(CLMM_PROGRAM_ID) ||
    !positionInfo.data.subarray(0, 8).equals(POSITION_DISCRIMINATOR)
  ) {
    throw new Error("Raydium CLMM personal position account not found for this NFT mint");
  }
  const position = PersonalPositionLayout.decode(positionInfo.data);
  const poolInfo = await connection.getAccountInfo(position.poolId, "confirmed");
  if (
    !poolInfo ||
    !poolInfo.owner.equals(CLMM_PROGRAM_ID) ||
    !poolInfo.data.subarray(0, 8).equals(POOL_DISCRIMINATOR)
  ) {
    throw new Error("Pool account missing or not a Raydium CLMM pool");
  }
  const pool = PoolInfoLayout.decode(poolInfo.data);
  const onChainPriceBPerA = Number(
    TickUtil.sqrtPriceX64ToPrice(pool.sqrtPriceX64, pool.mintDecimalsA, pool.mintDecimalsB).toString(),
  );
  if (!Number.isFinite(onChainPriceBPerA) || onChainPriceBPerA <= 0) {
    throw new Error("On-chain pool mid price is not a positive B-per-A value");
  }
  return {
    positionMint,
    poolId: position.poolId.toBase58(),
    mintA: pool.mintA.toBase58(),
    mintB: pool.mintB.toBase58(),
    decimalsA: pool.mintDecimalsA,
    decimalsB: pool.mintDecimalsB,
    tickLower: position.tickLower,
    tickUpper: position.tickUpper,
    tickCurrent: pool.tickCurrent,
    onChainPriceBPerA,
  };
}
