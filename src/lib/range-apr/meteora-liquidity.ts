import "@/lib/engine-host";
import "server-only";

import { PublicKey, type Connection } from "@solana/web3.js";
import { rpcConnection } from "@sofinance/engine/rpc";
import {
  decodeLbPair, decodeMeteoraBinArray, decodeMintDecimals, meteoraBaseFeeRate, meteoraBinArrayAddress,
  meteoraBinArrayIndex, meteoraBinArrayIndexesForRange, meteoraBinPrice, meteoraVariableFeeRate, mintHasFreezeAuthority,
  METEORA_BINS_PER_ARRAY, METEORA_FEE_PRECISION,
} from "@sofinance/engine/protocols/meteora/accounts";
import { METEORA_ALLOWLISTED_POOLS, METEORA_DLMM_PROGRAM_ID } from "@sofinance/engine/protocols/meteora/constants";
import { sqrtPriceAtTick } from "@sofinance/engine/range-apr/tick-math";
import { windowBounds, type LiquidityBin } from "./liquidity-bins";
import { halfWindowBinsFor, type OnchainPoolLiquidity } from "./onchain-liquidity";

export type MeteoraBinArrayInfo = {
  index: number;
  address: string;
  /** Inclusive bin id range the array covers. */
  lowerBinId: number;
  upperBinId: number;
  /** false = the account does not exist yet: opening a range here would pay its non-refundable rent. */
  exists: boolean;
  /** The pool's `bin_array_bitmap` marks this array as holding liquidity. */
  inBitmap: boolean;
  /** Bins in the array with a non-zero X or Y reserve. */
  nonEmptyBins: number;
};

/** Read-only LbPair state plus the bin reserves mapped onto the shared tick-bin range-APR shape. */
export type MeteoraPoolLiquidity = OnchainPoolLiquidity & {
  state: {
    binStep: number;
    activeId: number;
    status: number;
    /** Parts per 1e9 (100_000 → 0.01%). */
    baseFeeRate: number;
    /** Parts per 1e9, right now (volatility based; 0 when calm). */
    variableFeeRate: number;
    /** Basis points of the swap fee kept by Meteora (on-chain `protocol_share`). */
    protocolShare: number;
    reserveX: string;
    reserveY: string;
    /** On-chain mint freeze authority (true = still set). */
    freezeAuthorityX: boolean;
    freezeAuthorityY: boolean;
    slot: number;
    binArrays: MeteoraBinArrayInfo[];
    /**
     * The contiguous inclusive bin range around the active bin whose bin arrays all exist already. v1 opens
     * only inside it, so no bin-array rent is ever charged.
     */
    existingBinRange: { lowerBinId: number; upperBinId: number } | null;
    /** Reserves in the analysed window (raw units). */
    windowReserveX: string;
    windowReserveY: string;
  };
};

const PROGRAM = new PublicKey(METEORA_DLMM_PROGRAM_ID);
const Q64 = 2 ** 64;

/**
 * Shared-model liquidity for one DLMM bin. With bin step 1 a bin's price (1.0001^binId) is exactly tick `binId`,
 * so the bin is mapped onto tick bin [binId, binId + 1): its value in raw Y (x × price + y) divided by the
 * sqrt-price width of that tick is the concentrated-liquidity L holding the same value there. Own and other
 * liquidity are then compared in the same units (`estimateRangeApr`).
 */
export function dlmmBinLiquidity(amountX: bigint, amountY: bigint, binId: number, binStep: number): number {
  const valueY = Number(amountX) * meteoraBinPrice(binId, binStep) + Number(amountY);
  const width = sqrtPriceAtTick(binId + 1) - sqrtPriceAtTick(binId);
  return valueY > 0 && width > 0 ? valueY / width : 0;
}

/** sqrt(raw price) × 2^64 of a bin as a decimal string (the shared payload's `sqrtPriceX64`). */
export function binSqrtPriceX64(binId: number, binStep: number): string {
  return BigInt(Math.round(Math.sqrt(meteoraBinPrice(binId, binStep)) * Q64)).toString();
}

/**
 * One LbPair read, then one batched read of both mints and the bin arrays covering the analysed window.
 * Allowlisted pools only; any owner, mint, bin step, status or bin-array mismatch throws. Bin step 1 only
 * (a bin is then exactly one tick of the shared model).
 */
export async function readMeteoraPoolLiquidity(
  poolId: string, connection: Connection = rpcConnection(),
): Promise<MeteoraPoolLiquidity> {
  const spec = METEORA_ALLOWLISTED_POOLS.find((pool) => pool.poolAddress === poolId);
  if (!spec) throw new Error("Meteora pool is not allowlisted");
  const poolInfo = await connection.getAccountInfo(new PublicKey(poolId), "confirmed");
  if (!poolInfo || !poolInfo.owner.equals(PROGRAM)) throw new Error("Meteora DLMM pool account does not exist");
  const state = decodeLbPair(poolInfo.data);
  if (state.tokenXMint !== spec.mintX || state.tokenYMint !== spec.mintY) throw new Error("Meteora DLMM mint mismatch");
  if (state.binStep !== spec.binStep) throw new Error("Meteora DLMM bin step mismatch");
  if (state.binStep !== 1) throw new Error("Meteora range APR supports bin step 1 only");
  if (state.status !== 0) throw new Error("Meteora DLMM pool is disabled");
  const { activeId, binStep } = state;
  const half = halfWindowBinsFor(binStep);
  const { firstTick: firstBin, endTick } = windowBounds(activeId, binStep, half);
  const lastBin = endTick - 1;
  const indexes = meteoraBinArrayIndexesForRange(firstBin, lastBin);
  const arrayKeys = indexes.map((index) => meteoraBinArrayAddress(poolId, index));
  const { context, value: infos } = await connection.getMultipleAccountsInfoAndContext(
    [new PublicKey(state.tokenXMint), new PublicKey(state.tokenYMint), ...arrayKeys.map((key) => new PublicKey(key))],
    "confirmed",
  );
  const [mintX, mintY, ...arrays] = infos;
  if (!mintX || !mintY) throw new Error("Meteora pool mint account missing");
  if (mintX.owner.toBase58() !== spec.tokenProgramX || mintY.owner.toBase58() !== spec.tokenProgramY) {
    throw new Error("Meteora pool token program mismatch");
  }
  const bitmap = new Set(state.bitmapBinArrays);
  const reserves = new Map<number, { x: bigint; y: bigint }>();
  const binArrays: MeteoraBinArrayInfo[] = arrays.map((info, i) => {
    const index = indexes[i]!, address = arrayKeys[i]!;
    const lowerBinId = index * METEORA_BINS_PER_ARRAY, upperBinId = lowerBinId + METEORA_BINS_PER_ARRAY - 1;
    const base = { index, address, lowerBinId, upperBinId, inBitmap: bitmap.has(index) };
    if (!info) return { ...base, exists: false, nonEmptyBins: 0 };
    if (!info.owner.equals(PROGRAM)) throw new Error("Meteora bin array owner mismatch");
    const array = decodeMeteoraBinArray(info.data);
    if (array.lbPair !== poolId || array.index !== index) throw new Error("Meteora bin array pool or index mismatch");
    let nonEmptyBins = 0;
    for (const bin of array.bins) {
      if (bin.amountX === 0n && bin.amountY === 0n) continue;
      nonEmptyBins++;
      reserves.set(bin.binId, { x: bin.amountX, y: bin.amountY });
    }
    return { ...base, exists: true, nonEmptyBins };
  });
  let windowReserveX = 0n, windowReserveY = 0n;
  const bins: LiquidityBin[] = [];
  for (let binId = firstBin; binId <= lastBin; binId++) {
    const reserve = reserves.get(binId);
    if (reserve) { windowReserveX += reserve.x; windowReserveY += reserve.y; }
    bins.push({ tick: binId, liquidity: reserve ? dlmmBinLiquidity(reserve.x, reserve.y, binId, binStep) : 0 });
  }
  return {
    poolId,
    mintA: state.tokenXMint,
    mintB: state.tokenYMint,
    decimalsA: decodeMintDecimals(mintX.data),
    decimalsB: decodeMintDecimals(mintY.data),
    tickSpacing: binStep,
    tickCurrent: activeId,
    sqrtPriceX64: binSqrtPriceX64(activeId, binStep),
    bins,
    state: {
      binStep,
      activeId,
      status: state.status,
      baseFeeRate: meteoraBaseFeeRate(state),
      variableFeeRate: meteoraVariableFeeRate(state),
      protocolShare: state.protocolShare,
      reserveX: state.reserveX,
      reserveY: state.reserveY,
      freezeAuthorityX: mintHasFreezeAuthority(mintX.data),
      freezeAuthorityY: mintHasFreezeAuthority(mintY.data),
      slot: context.slot,
      binArrays,
      existingBinRange: existingBinRange(binArrays, activeId),
      windowReserveX: windowReserveX.toString(),
      windowReserveY: windowReserveY.toString(),
    },
  };
}

/** Contiguous run of existing bin arrays that contains the active bin, as an inclusive bin range. */
export function existingBinRange(binArrays: readonly MeteoraBinArrayInfo[], activeId: number) {
  const byIndex = new Map(binArrays.map((array) => [array.index, array]));
  const active = meteoraBinArrayIndex(activeId);
  if (!byIndex.get(active)?.exists) return null;
  let low = active, high = active;
  while (byIndex.get(low - 1)?.exists) low--;
  while (byIndex.get(high + 1)?.exists) high++;
  return { lowerBinId: byIndex.get(low)!.lowerBinId, upperBinId: byIndex.get(high)!.upperBinId };
}

/** Fee fraction helpers for the payload (parts per 1e9 → fraction). */
export const feeFraction = (rate: number) => rate / METEORA_FEE_PRECISION;
