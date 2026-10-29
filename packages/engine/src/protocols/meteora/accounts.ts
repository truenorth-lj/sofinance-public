import { PublicKey } from "@solana/web3.js";
import { METEORA_DLMM_PROGRAM_ID } from "./constants";

/**
 * Read-only decoders for Meteora DLMM (LB CLMM) program accounts (no SDK dependency).
 * Layouts follow the `lb_clmm` IDL shipped with `@meteora-ag/dlmm` 1.9.14 (`LbPair`, `BinArray`, `Bin`).
 * Nothing here builds or signs transactions.
 */

/** Bins per bin array account. */
export const METEORA_BINS_PER_ARRAY = 70;
/** `bin_array_bitmap` in the LbPair covers bin array indexes [-512, 511]; outside needs the bitmap extension. */
export const METEORA_BIN_ARRAY_BITMAP_SIZE = 512;
/** Fee rates are parts per 1e9. */
export const METEORA_FEE_PRECISION = 1_000_000_000;
export const METEORA_MAX_FEE_RATE = 100_000_000;
const BASIS_POINT_MAX = 10_000;

/** Anchor discriminators: sha256("account:<Name>")[0..8]. */
export const LB_PAIR_DISCRIMINATOR = "210b3162b565b10d";
export const BIN_ARRAY_DISCRIMINATOR = "5c8e5cdc059446b5";

export const LB_PAIR_ACCOUNT_LEN = 904;
const BIN_LEN = 144;
const BIN_ARRAY_HEADER_LEN = 56;
/** 8 disc + 8 index + 1 version + 7 padding + 32 lb_pair + 70 × 144. */
export const BIN_ARRAY_ACCOUNT_LEN = BIN_ARRAY_HEADER_LEN + METEORA_BINS_PER_ARRAY * BIN_LEN;

export type LbPairState = {
  /** bps per bin. */
  binStep: number;
  activeId: number;
  /** 0 = enabled. */
  status: number;
  pairType: number;
  baseFactor: number;
  baseFeePowerFactor: number;
  variableFeeControl: number;
  maxVolatilityAccumulator: number;
  volatilityAccumulator: number;
  minBinId: number;
  maxBinId: number;
  /** Basis points of the swap fee kept by the protocol. */
  protocolShare: number;
  tokenXMint: string;
  tokenYMint: string;
  reserveX: string;
  reserveY: string;
  /** Bin array indexes in [-512, 511] the pool marks as holding liquidity (`bin_array_bitmap`). */
  bitmapBinArrays: number[];
  /** 0 = SPL Token, 1 = Token-2022. */
  tokenProgramFlagX: number;
  tokenProgramFlagY: number;
};

export type MeteoraBin = { binId: number; amountX: bigint; amountY: bigint; priceX64: bigint; liquiditySupply: bigint };

export type MeteoraBinArray = { index: number; lbPair: string; version: number; bins: MeteoraBin[] };

const hex = (data: Uint8Array, start: number, end: number) => Buffer.from(data.subarray(start, end)).toString("hex");
const view = (data: Uint8Array) => new DataView(data.buffer, data.byteOffset, data.byteLength);
const key = (data: Uint8Array, offset: number) => new PublicKey(data.subarray(offset, offset + 32)).toBase58();

function u128(data: Uint8Array, offset: number): bigint {
  const v = view(data);
  return v.getBigUint64(offset, true) | (v.getBigUint64(offset + 8, true) << 64n);
}

export function decodeLbPair(data: Uint8Array): LbPairState {
  if (data.length < LB_PAIR_ACCOUNT_LEN || hex(data, 0, 8) !== LB_PAIR_DISCRIMINATOR) {
    throw new Error("Not a Meteora DLMM LbPair account");
  }
  const v = view(data);
  const bitmapBinArrays: number[] = [];
  for (let word = 0; word < 16; word++) {
    const bits = v.getBigUint64(584 + word * 8, true);
    for (let bit = 0; bit < 64; bit++) {
      if ((bits >> BigInt(bit)) & 1n) bitmapBinArrays.push(word * 64 + bit - METEORA_BIN_ARRAY_BITMAP_SIZE);
    }
  }
  return {
    // StaticParameters (8..40)
    baseFactor: v.getUint16(8, true),
    variableFeeControl: v.getUint32(16, true),
    maxVolatilityAccumulator: v.getUint32(20, true),
    minBinId: v.getInt32(24, true),
    maxBinId: v.getInt32(28, true),
    protocolShare: v.getUint16(32, true),
    baseFeePowerFactor: data[34]!,
    // VariableParameters (40..72)
    volatilityAccumulator: v.getUint32(40, true),
    pairType: data[75]!,
    activeId: v.getInt32(76, true),
    binStep: v.getUint16(80, true),
    status: data[82]!,
    tokenXMint: key(data, 88),
    tokenYMint: key(data, 120),
    reserveX: key(data, 152),
    reserveY: key(data, 184),
    bitmapBinArrays,
    tokenProgramFlagX: data[880]!,
    tokenProgramFlagY: data[881]!,
  };
}

export function decodeMeteoraBinArray(data: Uint8Array): MeteoraBinArray {
  if (data.length < 8 || hex(data, 0, 8) !== BIN_ARRAY_DISCRIMINATOR) throw new Error("Not a Meteora DLMM bin array account");
  if (data.length < BIN_ARRAY_ACCOUNT_LEN) throw new Error("Meteora bin array is truncated");
  const v = view(data);
  const index = Number(v.getBigInt64(8, true));
  const bins: MeteoraBin[] = [];
  for (let i = 0; i < METEORA_BINS_PER_ARRAY; i++) {
    const offset = BIN_ARRAY_HEADER_LEN + i * BIN_LEN;
    bins.push({
      binId: index * METEORA_BINS_PER_ARRAY + i,
      amountX: v.getBigUint64(offset, true),
      amountY: v.getBigUint64(offset + 8, true),
      priceX64: u128(data, offset + 16),
      liquiditySupply: u128(data, offset + 32),
    });
  }
  return { index, lbPair: key(data, 24), version: data[16]!, bins };
}

/** Bin array index holding `binId` (floor division, so -1 → -1). */
export function meteoraBinArrayIndex(binId: number): number {
  return Math.floor(binId / METEORA_BINS_PER_ARRAY);
}

/** Every bin array index overlapping the inclusive bin range `[lowerBinId, upperBinId]`. */
export function meteoraBinArrayIndexesForRange(lowerBinId: number, upperBinId: number): number[] {
  const indexes: number[] = [];
  for (let index = meteoraBinArrayIndex(lowerBinId); index <= meteoraBinArrayIndex(upperBinId); index++) indexes.push(index);
  return indexes;
}

/** PDA seeds: ["bin_array", lb_pair, index as i64 little-endian]. */
export function meteoraBinArrayAddress(lbPair: string, index: number, programId = METEORA_DLMM_PROGRAM_ID): string {
  const seed = Buffer.alloc(8);
  seed.writeBigInt64LE(BigInt(index));
  return PublicKey.findProgramAddressSync(
    [Buffer.from("bin_array"), new PublicKey(lbPair).toBuffer(), seed], new PublicKey(programId),
  )[0].toBase58();
}

/** Raw price (Y per X, smallest units) of a bin: (1 + binStep / 10_000)^binId. */
export function meteoraBinPrice(binId: number, binStep: number): number {
  return Math.pow(1 + binStep / BASIS_POINT_MAX, binId);
}

/** Base fee rate in parts per 1e9: base_factor × bin_step × 10 × 10^base_fee_power_factor. */
export function meteoraBaseFeeRate(state: Pick<LbPairState, "baseFactor" | "binStep" | "baseFeePowerFactor">): number {
  return state.baseFactor * state.binStep * 10 * Math.pow(10, state.baseFeePowerFactor);
}

/** Variable (volatility) fee rate in parts per 1e9 right now: ceil(vfc × (va × binStep)² / 1e11). */
export function meteoraVariableFeeRate(state: Pick<LbPairState, "variableFeeControl" | "volatilityAccumulator" | "binStep">): number {
  if (state.variableFeeControl === 0) return 0;
  const square = (BigInt(state.volatilityAccumulator) * BigInt(state.binStep)) ** 2n;
  const fee = BigInt(state.variableFeeControl) * square;
  return Number((fee + 99_999_999_999n) / 100_000_000_000n);
}

/** Total fee rate in parts per 1e9 (base + variable, capped at 10%). */
export function meteoraTotalFeeRate(state: Pick<LbPairState, "baseFactor" | "binStep" | "baseFeePowerFactor" | "variableFeeControl" | "volatilityAccumulator">): number {
  return Math.min(METEORA_MAX_FEE_RATE, meteoraBaseFeeRate(state) + meteoraVariableFeeRate(state));
}

/** SPL / Token-2022 mint decimals (byte 44 of the base mint layout). */
export function decodeMintDecimals(data: Uint8Array): number {
  if (data.length < 82) throw new Error("Not a token mint account");
  return data[44]!;
}

/** Whether the mint still has a freeze authority (COption tag at byte 46). */
export function mintHasFreezeAuthority(data: Uint8Array): boolean {
  if (data.length < 82) throw new Error("Not a token mint account");
  return view(data).getUint32(46, true) === 1;
}
