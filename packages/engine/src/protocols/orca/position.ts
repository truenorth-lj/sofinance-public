import { PublicKey } from "@solana/web3.js";
import { accruedFee } from "../../compound-math";
import { positionSide } from "../../quote-math";
import { DYNAMIC_TICK_ARRAY_DISCRIMINATOR, FIXED_TICK_ARRAY_DISCRIMINATOR, FIXED_TICK_ARRAY_LEN, ORCA_TICK_ARRAY_SIZE, WHIRLPOOL_ACCOUNT_LEN, WHIRLPOOL_DISCRIMINATOR, orcaTickArrayStartIndex } from "./accounts";
import { ORCA_WHIRLPOOL_PROGRAM_ID } from "./constants";

/**
 * Read-only Orca Whirlpool position math: Position account decode, PDA from
 * the position NFT, uncollected fees, token amounts and range side. Pure
 * bigint ports of `rust-sdk/core` (`collect_fees_quote`,
 * `try_get_token_estimates_from_liquidity`, `tick_index_to_sqrt_price`,
 * `position_status`); parity with `@orca-so/whirlpools-core` is asserted in
 * tests on mainnet captures. No transaction building or signing.
 */

/** sha256("account:Position")[0..8] */
export const ORCA_POSITION_DISCRIMINATOR = "aabc8fe47a40f7d0";
/** 8 + 32 + 32 + 16 + 4 + 4 + 16 + 8 + 16 + 8 + 3 × (16 + 8) */
export const ORCA_POSITION_ACCOUNT_LEN = 216;
export const ORCA_MIN_TICK = -443636;
export const ORCA_MAX_TICK = 443636;

export type OrcaPosition = {
  whirlpool: string;
  positionMint: string;
  liquidity: bigint;
  tickLowerIndex: number;
  tickUpperIndex: number;
  feeGrowthCheckpointA: bigint;
  feeOwedA: bigint;
  feeGrowthCheckpointB: bigint;
  feeOwedB: bigint;
};

export type OrcaWhirlpoolFeeGrowth = { feeGrowthGlobalA: bigint; feeGrowthGlobalB: bigint };
export type OrcaTickFeeGrowth = { initialized: boolean; feeGrowthOutsideA: bigint; feeGrowthOutsideB: bigint };

const hex = (data: Uint8Array, start: number, end: number) => Buffer.from(data.subarray(start, end)).toString("hex");
const view = (data: Uint8Array) => new DataView(data.buffer, data.byteOffset, data.byteLength);
const key = (data: Uint8Array, offset: number) => new PublicKey(data.subarray(offset, offset + 32)).toBase58();
const u64 = (data: Uint8Array, offset: number) => view(data).getBigUint64(offset, true);
const u128 = (data: Uint8Array, offset: number) => u64(data, offset) | (u64(data, offset + 8) << 64n);

export function orcaPositionAddress(positionMint: string, programId = ORCA_WHIRLPOOL_PROGRAM_ID): string {
  return PublicKey.findProgramAddressSync([Buffer.from("position"), new PublicKey(positionMint).toBuffer()], new PublicKey(programId))[0].toBase58();
}

export function isOrcaPositionAccount(data: Uint8Array): boolean {
  return data.length === ORCA_POSITION_ACCOUNT_LEN && hex(data, 0, 8) === ORCA_POSITION_DISCRIMINATOR;
}

export function decodeOrcaPosition(data: Uint8Array): OrcaPosition {
  if (!isOrcaPositionAccount(data)) throw new Error("Not an Orca Whirlpool position account");
  const v = view(data);
  return {
    whirlpool: key(data, 8),
    positionMint: key(data, 40),
    liquidity: u128(data, 72),
    tickLowerIndex: v.getInt32(88, true),
    tickUpperIndex: v.getInt32(92, true),
    feeGrowthCheckpointA: u128(data, 96),
    feeOwedA: u64(data, 112),
    feeGrowthCheckpointB: u128(data, 120),
    feeOwedB: u64(data, 136),
  };
}

/** `fee_growth_global_a` (@165) and `fee_growth_global_b` (@245) of a Whirlpool account. */
export function decodeWhirlpoolFeeGrowth(data: Uint8Array): OrcaWhirlpoolFeeGrowth {
  if (data.length < WHIRLPOOL_ACCOUNT_LEN || hex(data, 0, 8) !== WHIRLPOOL_DISCRIMINATOR) throw new Error("Not an Orca Whirlpool account");
  return { feeGrowthGlobalA: u128(data, 165), feeGrowthGlobalB: u128(data, 245) };
}

/**
 * Fee growth outside one tick of a fixed or dynamic tick array. Uninitialised
 * ticks read as zero (the program's default tick).
 */
export function readOrcaTickFeeGrowth(data: Uint8Array, tickSpacing: number, tickIndex: number): OrcaTickFeeGrowth {
  if (!Number.isInteger(tickSpacing) || tickSpacing <= 0) throw new Error("Invalid Orca tick spacing");
  if (!Number.isInteger(tickIndex) || tickIndex % tickSpacing !== 0) throw new Error("Orca tick is not on the tick spacing");
  const discriminator = data.length >= 8 ? hex(data, 0, 8) : "";
  const start = data.length >= 12 ? view(data).getInt32(8, true) : NaN;
  if (start !== orcaTickArrayStartIndex(tickIndex, tickSpacing)) {
    if (discriminator === FIXED_TICK_ARRAY_DISCRIMINATOR || discriminator === DYNAMIC_TICK_ARRAY_DISCRIMINATOR) throw new Error("Orca tick is outside this tick array");
    throw new Error("Not an Orca tick array account");
  }
  const slot = (tickIndex - start) / tickSpacing;
  const empty = { initialized: false, feeGrowthOutsideA: 0n, feeGrowthOutsideB: 0n };
  // Tick layout (after the 1-byte initialised flag / tag): net i128, gross u128, outside_a, outside_b, rewards.
  const read = (offset: number) => ({ initialized: true, feeGrowthOutsideA: u128(data, offset + 33), feeGrowthOutsideB: u128(data, offset + 49) });
  if (discriminator === FIXED_TICK_ARRAY_DISCRIMINATOR) {
    if (data.length < FIXED_TICK_ARRAY_LEN) throw new Error("Orca tick array is truncated");
    const offset = 12 + slot * 113;
    return data[offset] === 1 ? read(offset) : empty;
  }
  if (discriminator === DYNAMIC_TICK_ARRAY_DISCRIMINATOR) {
    if (data.length < 60 + ORCA_TICK_ARRAY_SIZE) throw new Error("Orca tick array is truncated");
    let offset = 60;
    for (let i = 0; i < ORCA_TICK_ARRAY_SIZE; i++) {
      const tag = data[offset];
      if (tag !== 0 && tag !== 1) throw new Error("Orca dynamic tick has an unknown tag");
      if (tag === 1 && offset + 113 > data.length) throw new Error("Orca tick array is truncated");
      if (i === slot) return tag === 1 ? read(offset) : empty;
      offset += tag === 1 ? 113 : 1;
    }
  }
  throw new Error("Not an Orca tick array account");
}

const POSITIVE_TICK_FACTORS: readonly bigint[] = [
  79236085330515764027303304731n, 79244008939048815603706035061n, 79259858533276714757314932305n,
  79291567232598584799939703904n, 79355022692464371645785046466n, 79482085999252804386437311141n,
  79736823300114093921829183326n, 80248749790819932309965073892n, 81282483887344747381513967011n,
  83390072131320151908154831281n, 87770609709833776024991924138n, 97234110755111693312479820773n,
  119332217159966728226237229890n, 179736315981702064433883588727n, 407748233172238350107850275304n,
  2098478828474011932436660412517n, 55581415166113811149459800483533n, 38992368544603139932233054999993551n,
];
const NEGATIVE_TICK_FACTORS: readonly bigint[] = [
  18444899583751176498n, 18443055278223354162n, 18439367220385604838n, 18431993317065449817n,
  18417254355718160513n, 18387811781193591352n, 18329067761203520168n, 18212142134806087854n,
  17980523815641551639n, 17526086738831147013n, 16651378430235024244n, 15030750278693429944n,
  12247334978882834399n, 8131365268884726200n, 3584323654723342297n, 696457651847595233n,
  26294789957452057n, 37481735321082n,
];
const U128_MASK = (1n << 128n) - 1n;
const MAX_U64 = (1n << 64n) - 1n;

/** Orca `tick_index_to_sqrt_price` (Q64.64). Differs from Raydium's in the low bits. */
export function orcaTickIndexToSqrtPrice(tick: number): bigint {
  if (!Number.isInteger(tick) || tick < ORCA_MIN_TICK || tick > ORCA_MAX_TICK) throw new Error("Orca tick index out of range");
  if (tick >= 0) {
    let ratio = tick & 1 ? 79232123823359799118286999567n : 79228162514264337593543950336n;
    POSITIVE_TICK_FACTORS.forEach((factor, i) => { if (tick & (2 << i)) ratio = ((ratio * factor) >> 96n) & U128_MASK; });
    return ratio >> 32n;
  }
  const abs = -tick;
  let ratio = abs & 1 ? 18445821805675392311n : 18446744073709551616n;
  NEGATIVE_TICK_FACTORS.forEach((factor, i) => { if (abs & (2 << i)) ratio = ((ratio * factor) >> 64n) & U128_MASK; });
  return ratio;
}

/** Orca `position_status`: by sqrt price, lower bound inclusive below, upper inclusive above. */
export function orcaRangeSide(sqrtPriceX64: bigint, tickLower: number, tickUpper: number): "below" | "inside" | "above" {
  return positionSide(sqrtPriceX64, orcaTickIndexToSqrtPrice(tickLower), orcaTickIndexToSqrtPrice(tickUpper));
}

/** Orca `try_get_token_estimates_from_liquidity(round_up = false)`: what withdrawing `liquidity` returns, before transfer fees. */
export function orcaAmountsForLiquidity(liquidity: bigint, sqrtPriceX64: bigint, tickLower: number, tickUpper: number): { amountA: bigint; amountB: bigint } {
  if (liquidity < 0n || liquidity > U128_MASK) throw new Error("Invalid Orca position liquidity");
  if (liquidity === 0n || tickLower === tickUpper) return { amountA: 0n, amountB: 0n };
  const lower = orcaTickIndexToSqrtPrice(Math.min(tickLower, tickUpper));
  const upper = orcaTickIndexToSqrtPrice(Math.max(tickLower, tickUpper));
  const tokenA = (from: bigint, to: bigint) => ((liquidity * (to - from)) << 64n) / (to * from);
  const tokenB = (from: bigint, to: bigint) => (liquidity * (to - from)) >> 64n;
  const side = positionSide(sqrtPriceX64, lower, upper);
  const amounts = side === "below" ? { amountA: tokenA(lower, upper), amountB: 0n }
    : side === "above" ? { amountA: 0n, amountB: tokenB(lower, upper) }
      : { amountA: tokenA(sqrtPriceX64, upper), amountB: tokenB(lower, sqrtPriceX64) };
  if (amounts.amountA > MAX_U64 || amounts.amountB > MAX_U64) throw new Error("Orca token amount exceeds u64 range");
  return amounts;
}

/** Orca `collect_fees_quote` before transfer fees (fee_owed + accrued since the checkpoint). */
export function orcaUncollectedFees(input: {
  tickCurrentIndex: number;
  feeGrowth: OrcaWhirlpoolFeeGrowth;
  position: OrcaPosition;
  lower: OrcaTickFeeGrowth;
  upper: OrcaTickFeeGrowth;
}): { feeA: bigint; feeB: bigint } {
  const { position } = input;
  const common = { tickCurrent: input.tickCurrentIndex, tickLower: position.tickLowerIndex, tickUpper: position.tickUpperIndex, liquidity: position.liquidity };
  return {
    feeA: accruedFee({ ...common, global: input.feeGrowth.feeGrowthGlobalA, lowerOutside: input.lower.feeGrowthOutsideA, upperOutside: input.upper.feeGrowthOutsideA, lastInside: position.feeGrowthCheckpointA, owed: position.feeOwedA }),
    feeB: accruedFee({ ...common, global: input.feeGrowth.feeGrowthGlobalB, lowerOutside: input.lower.feeGrowthOutsideB, upperOutside: input.upper.feeGrowthOutsideB, lastInside: position.feeGrowthCheckpointB, owed: position.feeOwedB }),
  };
}
