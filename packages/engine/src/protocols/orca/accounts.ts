import { PublicKey } from "@solana/web3.js";
import { ORCA_WHIRLPOOL_PROGRAM_ID } from "./constants";

/**
 * Read-only decoders for Orca Whirlpool program accounts (no SDK dependency).
 * Layouts follow `programs/whirlpool/src/state/{whirlpool,fixed_tick_array,dynamic_tick_array}.rs`.
 * Nothing here builds or signs transactions.
 */

/** Ticks per Orca tick array (Raydium uses 60). */
export const ORCA_TICK_ARRAY_SIZE = 88;

/** Anchor discriminators: sha256("account:<Name>")[0..8]. */
export const WHIRLPOOL_DISCRIMINATOR = "3f95d10ce1806309";
export const FIXED_TICK_ARRAY_DISCRIMINATOR = "4561bdbe6e0742bb";
export const DYNAMIC_TICK_ARRAY_DISCRIMINATOR = "11d8f68ee1c7da38";

/** Whirlpool account size (8 + 261 + 384). */
export const WHIRLPOOL_ACCOUNT_LEN = 653;
const TICK_LEN = 113;
const DYNAMIC_TICK_DATA_LEN = 112;
/** 8 + 4 + 88 × 113 + 32 */
export const FIXED_TICK_ARRAY_LEN = 8 + 4 + ORCA_TICK_ARRAY_SIZE * TICK_LEN + 32;

export type WhirlpoolState = {
  whirlpoolsConfig: string;
  tickSpacing: number;
  /** Hundredths of a bp (100 → 0.01%). */
  feeRate: number;
  /** Basis points of the swap fee kept by the protocol (1300 → 13%). */
  protocolFeeRate: number;
  liquidity: bigint;
  sqrtPriceX64: bigint;
  tickCurrentIndex: number;
  tokenMintA: string;
  tokenVaultA: string;
  tokenMintB: string;
  tokenVaultB: string;
};

export type OrcaTick = { tick: number; liquidityNet: bigint; liquidityGross: bigint };

export type OrcaTickArray = {
  kind: "fixed" | "dynamic";
  whirlpool: string;
  startTickIndex: number;
  /** Initialised ticks only, ascending. */
  ticks: OrcaTick[];
};

const hex = (data: Uint8Array, start: number, end: number) => Buffer.from(data.subarray(start, end)).toString("hex");
const view = (data: Uint8Array) => new DataView(data.buffer, data.byteOffset, data.byteLength);
const key = (data: Uint8Array, offset: number) => new PublicKey(data.subarray(offset, offset + 32)).toBase58();

function u128(data: Uint8Array, offset: number): bigint {
  const v = view(data);
  return v.getBigUint64(offset, true) | (v.getBigUint64(offset + 8, true) << 64n);
}

function i128(data: Uint8Array, offset: number): bigint {
  return BigInt.asIntN(128, u128(data, offset));
}

export function decodeWhirlpool(data: Uint8Array): WhirlpoolState {
  if (data.length < WHIRLPOOL_ACCOUNT_LEN || hex(data, 0, 8) !== WHIRLPOOL_DISCRIMINATOR) {
    throw new Error("Not an Orca Whirlpool account");
  }
  const v = view(data);
  return {
    whirlpoolsConfig: key(data, 8),
    tickSpacing: v.getUint16(41, true),
    feeRate: v.getUint16(45, true),
    protocolFeeRate: v.getUint16(47, true),
    liquidity: u128(data, 49),
    sqrtPriceX64: u128(data, 65),
    tickCurrentIndex: v.getInt32(81, true),
    tokenMintA: key(data, 101),
    tokenVaultA: key(data, 133),
    tokenMintB: key(data, 181),
    tokenVaultB: key(data, 213),
  };
}

/** Decodes a fixed (9988-byte) or dynamic (variable-size) tick array. */
export function decodeOrcaTickArray(data: Uint8Array, tickSpacing: number): OrcaTickArray {
  const discriminator = data.length >= 8 ? hex(data, 0, 8) : "";
  const v = view(data);
  const ticks: OrcaTick[] = [];
  if (discriminator === FIXED_TICK_ARRAY_DISCRIMINATOR) {
    if (data.length < FIXED_TICK_ARRAY_LEN) throw new Error("Orca tick array is truncated");
    const startTickIndex = v.getInt32(8, true);
    for (let i = 0; i < ORCA_TICK_ARRAY_SIZE; i++) {
      const offset = 12 + i * TICK_LEN;
      if (data[offset] !== 1) continue;
      ticks.push({ tick: startTickIndex + i * tickSpacing, liquidityNet: i128(data, offset + 1), liquidityGross: u128(data, offset + 17) });
    }
    return { kind: "fixed", whirlpool: key(data, 12 + ORCA_TICK_ARRAY_SIZE * TICK_LEN), startTickIndex, ticks };
  }
  if (discriminator === DYNAMIC_TICK_ARRAY_DISCRIMINATOR) {
    // 8 disc | 4 start | 32 whirlpool | 16 tick_bitmap | 88 × (1 tag [+ 112 data])
    if (data.length < 60 + ORCA_TICK_ARRAY_SIZE) throw new Error("Orca tick array is truncated");
    const startTickIndex = v.getInt32(8, true);
    const bitmap = u128(data, 44);
    let offset = 60;
    for (let i = 0; i < ORCA_TICK_ARRAY_SIZE; i++) {
      const tag = data[offset];
      const initialized = ((bitmap >> BigInt(i)) & 1n) === 1n;
      if (tag !== 0 && tag !== 1) throw new Error("Orca dynamic tick has an unknown tag");
      if ((tag === 1) !== initialized) throw new Error("Orca dynamic tick bitmap mismatch");
      if (tag === 0) { offset += 1; continue; }
      if (offset + 1 + DYNAMIC_TICK_DATA_LEN > data.length) throw new Error("Orca tick array is truncated");
      ticks.push({ tick: startTickIndex + i * tickSpacing, liquidityNet: i128(data, offset + 1), liquidityGross: u128(data, offset + 17) });
      offset += 1 + DYNAMIC_TICK_DATA_LEN;
    }
    return { kind: "dynamic", whirlpool: key(data, 12), startTickIndex, ticks };
  }
  throw new Error("Not an Orca tick array account");
}

export function orcaTickArrayStartIndex(tick: number, tickSpacing: number): number {
  const span = ORCA_TICK_ARRAY_SIZE * tickSpacing;
  return Math.floor(tick / span) * span;
}

/** Start indexes of every Orca tick array that overlaps `[lowTick, highTick]`. */
export function orcaTickArrayStartsForWindow(lowTick: number, highTick: number, tickSpacing: number): number[] {
  const span = ORCA_TICK_ARRAY_SIZE * tickSpacing;
  const starts: number[] = [];
  for (let start = orcaTickArrayStartIndex(lowTick, tickSpacing); start <= highTick; start += span) starts.push(start);
  return starts;
}

/** PDA seeds: ["tick_array", whirlpool, start_tick_index as decimal string]. */
export function orcaTickArrayAddress(whirlpool: string, startTickIndex: number, programId = ORCA_WHIRLPOOL_PROGRAM_ID): string {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("tick_array"), new PublicKey(whirlpool).toBuffer(), Buffer.from(String(startTickIndex))],
    new PublicKey(programId),
  )[0].toBase58();
}

/** SPL / Token-2022 mint decimals (byte 44 of the base mint layout). */
export function decodeMintDecimals(data: Uint8Array): number {
  if (data.length < 82) throw new Error("Not a token mint account");
  return data[44]!;
}
