import { createHash } from "node:crypto";
import {
  CLMM_PROGRAM_ID,
  getPdaPersonalPositionAddress,
  getPdaTickArrayAddress,
  LiquidityMathUtil,
  PersonalPositionLayout,
  PoolInfoLayout,
  TickArrayLayout,
  TickArrayUtil,
  TickUtil,
} from "@raydium-io/raydium-sdk-v2";
import BN from "bn.js";
import { Connection, PublicKey } from "@solana/web3.js";
import { accruedFee } from "../../compound-math";
import { positionSide } from "../../quote-math";
import type { ClmmPositionAccounts } from "../types";

const POSITION_DISCRIMINATOR = createHash("sha256").update("account:PersonalPositionState").digest().subarray(0, 8);
const POOL_DISCRIMINATOR = createHash("sha256").update("account:PoolState").digest().subarray(0, 8);

function growth(value: { toString(): string }): bigint {
  return BigInt(value.toString());
}

/**
 * Raydium CLMM position and pool accounts for holding-period valuation.
 * Liquidity amounts use the same round-down rule as the previous app reader.
 * This does not check wallet ownership or require an input token.
 */
export async function readRaydiumPositionAccounts(positionMint: string, connection: Connection): Promise<ClmmPositionAccounts> {
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
  if (!position.nftMint.equals(mint)) throw new Error("Position NFT mint mismatch");

  const poolId = position.poolId;
  const poolInfo = await connection.getAccountInfo(poolId, "confirmed");
  if (
    !poolInfo ||
    !poolInfo.owner.equals(CLMM_PROGRAM_ID) ||
    !poolInfo.data.subarray(0, 8).equals(POOL_DISCRIMINATOR)
  ) {
    throw new Error("Pool account missing or not a Raydium CLMM pool");
  }
  const pool = PoolInfoLayout.decode(poolInfo.data);
  const lower = TickUtil.getSqrtPriceAtTick(position.tickLower);
  const upper = TickUtil.getSqrtPriceAtTick(position.tickUpper);
  const currentAmounts = LiquidityMathUtil.getAmountsForLiquidity(
    pool.sqrtPriceX64,
    lower,
    upper,
    position.liquidity,
    false,
  );
  const rangeSide = positionSide(
    BigInt(pool.sqrtPriceX64.toString()),
    BigInt(lower.toString()),
    BigInt(upper.toString()),
  );

  return {
    positionAccount: positionPda.toBase58(),
    poolId: poolId.toBase58(),
    mintA: pool.mintA.toBase58(),
    mintB: pool.mintB.toBase58(),
    vaultA: pool.vaultA.toBase58(),
    vaultB: pool.vaultB.toBase58(),
    decimalsA: pool.mintDecimalsA,
    decimalsB: pool.mintDecimalsB,
    tickLower: position.tickLower,
    tickUpper: position.tickUpper,
    tickCurrent: pool.tickCurrent,
    tickSpacing: pool.tickSpacing,
    liquidity: position.liquidity.toString(),
    sqrtPriceX64: pool.sqrtPriceX64.toString(),
    rangeSide,
    amountA: BigInt(currentAmounts.amountA.toString()),
    amountB: BigInt(currentAmounts.amountB.toString()),
    stateFingerprint: createHash("sha256").update(positionInfo.data).digest("hex"),
    programId: CLMM_PROGRAM_ID.toBase58(),
    feeGrowthGlobalA: growth(pool.feeGrowthGlobalX64A),
    feeGrowthGlobalB: growth(pool.feeGrowthGlobalX64B),
    feeGrowthInsideLastA: growth(position.feeGrowthInsideLastX64A),
    feeGrowthInsideLastB: growth(position.feeGrowthInsideLastX64B),
    tokenFeesOwedA: growth(position.tokenFeesOwedA),
    tokenFeesOwedB: growth(position.tokenFeesOwedB),
  };
}

/**
 * Uncollected swap fees for a snapshot. Same tick-array checks as the app reader:
 * a zero-liquidity boundary tick is still accepted.
 */
export async function readRaydiumUncollectedFees(
  connection: Connection,
  accounts: ClmmPositionAccounts,
): Promise<{ a: bigint; b: bigint }> {
  const programId = new PublicKey(accounts.programId);
  const poolId = new PublicKey(accounts.poolId);
  const ticks = [accounts.tickLower, accounts.tickUpper];
  const starts = ticks.map((tick) => TickArrayUtil.getTickArrayStartIndex(tick, accounts.tickSpacing));
  const keys = starts.map((start) => getPdaTickArrayAddress(programId, poolId, start).publicKey);
  const infos = await connection.getMultipleAccountsInfo(keys, "confirmed");
  const boundaries = infos.map((info, index) => {
    if (!info || !info.owner.equals(programId)) throw new Error("Boundary tick array missing for fee accrual");
    const array = TickArrayLayout.decode(info.data);
    if (array.poolId.toBase58() !== poolId.toBase58() || array.startTickIndex !== starts[index]) {
      throw new Error("Tick array does not match pool or start index");
    }
    const tick = array.ticks[TickArrayUtil.getTickOffsetInArray(ticks[index]!, accounts.tickSpacing)];
    if (!tick || tick.tick !== ticks[index]) throw new Error("Boundary tick not initialized");
    return tick;
  });
  const lower = boundaries[0]!;
  const upper = boundaries[1]!;
  const fee = (side: "A" | "B") => accruedFee({
    tickCurrent: accounts.tickCurrent,
    tickLower: accounts.tickLower,
    tickUpper: accounts.tickUpper,
    global: side === "A" ? accounts.feeGrowthGlobalA : accounts.feeGrowthGlobalB,
    lowerOutside: growth(lower[`feeGrowthOutsideX64${side}`]),
    upperOutside: growth(upper[`feeGrowthOutsideX64${side}`]),
    lastInside: side === "A" ? accounts.feeGrowthInsideLastA : accounts.feeGrowthInsideLastB,
    liquidity: BigInt(accounts.liquidity),
    owed: side === "A" ? accounts.tokenFeesOwedA : accounts.tokenFeesOwedB,
  });
  return { a: fee("A"), b: fee("B") };
}

export type RaydiumPersonalPosition = {
  nftMint: string;
  poolId: string;
  tickLower: number;
  tickUpper: number;
  liquidity: string;
};

/** Decode a personal-position account. Callers keep their own owner and discriminator checks. */
export function decodeRaydiumPersonalPosition(data: Uint8Array): RaydiumPersonalPosition {
  const position = PersonalPositionLayout.decode(Buffer.from(data));
  return {
    nftMint: position.nftMint.toBase58(),
    poolId: position.poolId.toBase58(),
    tickLower: position.tickLower,
    tickUpper: position.tickUpper,
    liquidity: position.liquidity.toString(),
  };
}

export type RaydiumRangeFacts = {
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

/** Range status for a Raydium CLMM position: the valuation snapshot plus the pool mid price. */
export async function readRaydiumRangeFacts(positionMint: string, connection: Connection): Promise<RaydiumRangeFacts> {
  const accounts = await readRaydiumPositionAccounts(positionMint, connection);
  const onChainPriceBPerA = Number(
    TickUtil.sqrtPriceX64ToPrice(new BN(accounts.sqrtPriceX64), accounts.decimalsA, accounts.decimalsB).toString(),
  );
  if (!Number.isFinite(onChainPriceBPerA) || onChainPriceBPerA <= 0) {
    throw new Error("On-chain pool mid price is not a positive B-per-A value");
  }
  return {
    positionMint,
    poolId: accounts.poolId,
    mintA: accounts.mintA,
    mintB: accounts.mintB,
    decimalsA: accounts.decimalsA,
    decimalsB: accounts.decimalsB,
    tickLower: accounts.tickLower,
    tickUpper: accounts.tickUpper,
    tickCurrent: accounts.tickCurrent,
    onChainPriceBPerA,
  };
}
