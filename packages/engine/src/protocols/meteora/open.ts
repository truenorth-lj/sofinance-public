import { PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY, TransactionInstruction } from "@solana/web3.js";
import { METEORA_BIN_ARRAY_BITMAP_SIZE, meteoraBinArrayAddress, meteoraBinArrayIndexesForRange } from "./accounts";
import { METEORA_DLMM_PROGRAM_ID } from "./constants";
import { METEORA_POSITION_BASE_BINS } from "./position";

/**
 * Meteora DLMM open-position instructions, hand-encoded from the `lb_clmm` IDL shipped with
 * `@meteora-ag/dlmm` 1.9.14 (no SDK / Anchor dependency; byte parity with the SDK's Anchor coder is
 * pinned in open.test.ts). These build instructions only: nothing here signs or sends.
 *
 * None of these instructions touches the SoFinance fee wallet: the protocol fee is charged only on
 * swapped input, inside the Jupiter legs (`platformFeeBps`), never by these instructions.
 */

/** sha256("global:<name>")[0..8]. */
export const METEORA_IX_DISCRIMINATOR = Object.freeze({
  initializePosition: "dbc0ea47bebf6650",
  addLiquidityByStrategy2: "03dd95da6f8d76d5",
  closePosition2: "ae5a2373ba2893e2",
});

/** `StrategyType::SpotImBalanced` (what the SDK sends for "Spot"). */
export const METEORA_STRATEGY_SPOT_IMBALANCED = 6;
/** v1 opens a base-size `PositionV2` (70 bins, 8,120 bytes); wider positions would need `increase_position_length`. */
export const METEORA_OPEN_MAX_WIDTH = METEORA_POSITION_BASE_BINS;

const program = (programId: string) => new PublicKey(programId);

/** PDA ["__event_authority"] used by every Anchor `emit_cpi!` instruction. */
export function meteoraEventAuthority(programId = METEORA_DLMM_PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], program(programId))[0];
}

/** PDA ["bitmap", lb_pair]: only needed for bin array indexes outside [-512, 511]. */
export function meteoraBitmapExtensionAddress(lbPair: string, programId = METEORA_DLMM_PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("bitmap"), new PublicKey(lbPair).toBuffer()], program(programId))[0];
}

export function meteoraRangeNeedsBitmapExtension(lowerBinId: number, upperBinId: number): boolean {
  return meteoraBinArrayIndexesForRange(lowerBinId, upperBinId)
    .some((index) => index < -METEORA_BIN_ARRAY_BITMAP_SIZE || index >= METEORA_BIN_ARRAY_BITMAP_SIZE);
}

function i32(value: number) {
  if (!Number.isSafeInteger(value) || value < -(2 ** 31) || value >= 2 ** 31) throw new Error("i32 out of range");
  const buffer = Buffer.alloc(4);
  buffer.writeInt32LE(value);
  return buffer;
}

function u64(value: bigint) {
  if (value < 0n || value >= 2n ** 64n) throw new Error("u64 out of range");
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64LE(value);
  return buffer;
}

/**
 * Validates a v1 open range (at most 70 bins). A range whose bin arrays sit outside [-512, 511] is accepted only
 * when the caller passes the pool's bitmap extension (`withBitmapExtension`); without it the program would reject it.
 */
export function assertMeteoraOpenRange(lowerBinId: number, upperBinId: number, options: { withBitmapExtension?: boolean } = {}) {
  if (!Number.isSafeInteger(lowerBinId) || !Number.isSafeInteger(upperBinId) || upperBinId < lowerBinId) {
    throw new Error("Invalid Meteora bin range");
  }
  const width = upperBinId - lowerBinId + 1;
  if (width > METEORA_OPEN_MAX_WIDTH) throw new Error(`Meteora v1 positions span at most ${METEORA_OPEN_MAX_WIDTH} bins`);
  if (!options.withBitmapExtension && meteoraRangeNeedsBitmapExtension(lowerBinId, upperBinId)) {
    throw new Error("Meteora v1 does not open ranges that need the bitmap extension");
  }
  return width;
}

/** Validates any inclusive bin range (withdraw / claim cover the position's own bins). */
export function assertMeteoraBinRange(lowerBinId: number, upperBinId: number) {
  if (!Number.isSafeInteger(lowerBinId) || !Number.isSafeInteger(upperBinId) || upperBinId < lowerBinId) {
    throw new Error("Invalid Meteora bin range");
  }
  return upperBinId - lowerBinId + 1;
}

/**
 * The optional `bin_array_bitmap_extension` account of liquidity instructions: the pool's ["bitmap", lb_pair] PDA
 * (writable) when given, otherwise Anchor's "absent" placeholder (the program id, read-only).
 */
export function meteoraBitmapExtensionMeta(bitmapExtension: PublicKey | undefined, programId = METEORA_DLMM_PROGRAM_ID) {
  return bitmapExtension
    ? { pubkey: bitmapExtension, isSigner: false, isWritable: true }
    : { pubkey: program(programId), isSigner: false, isWritable: false };
}

/**
 * `initialize_position(lower_bin_id, width)`: the program creates the position account (a fresh keypair,
 * which signs) with `payer` funding its rent. The rent is refunded to the owner by `close_position2`.
 */
export function meteoraInitializePositionInstruction(input: {
  payer: PublicKey; position: PublicKey; lbPair: PublicKey; owner: PublicKey; lowerBinId: number; width: number; programId?: string;
}) {
  const programId = input.programId ?? METEORA_DLMM_PROGRAM_ID;
  if (!Number.isInteger(input.width) || input.width < 1 || input.width > METEORA_OPEN_MAX_WIDTH) throw new Error("Invalid Meteora position width");
  return new TransactionInstruction({
    programId: program(programId),
    keys: [
      { pubkey: input.payer, isSigner: true, isWritable: true },
      { pubkey: input.position, isSigner: true, isWritable: true },
      { pubkey: input.lbPair, isSigner: false, isWritable: false },
      { pubkey: input.owner, isSigner: true, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: meteoraEventAuthority(programId), isSigner: false, isWritable: false },
      { pubkey: program(programId), isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([Buffer.from(METEORA_IX_DISCRIMINATOR.initializePosition, "hex"), i32(input.lowerBinId), i32(input.width)]),
  });
}

export type MeteoraAddLiquidityInput = {
  position: PublicKey; lbPair: PublicKey; sender: PublicKey;
  userTokenX: PublicKey; userTokenY: PublicKey; reserveX: PublicKey; reserveY: PublicKey;
  tokenXMint: PublicKey; tokenYMint: PublicKey; tokenXProgram: PublicKey; tokenYProgram: PublicKey;
  amountX: bigint; amountY: bigint; activeId: number; maxActiveBinSlippage: number;
  minBinId: number; maxBinId: number; programId?: string;
  /** The pool's bitmap extension PDA; required when the range's bin arrays sit outside [-512, 511]. */
  bitmapExtension?: PublicKey;
};

/**
 * `add_liquidity_by_strategy2` with Spot (SpotImBalanced) over `[minBinId, maxBinId]`. Remaining accounts:
 * no transfer-hook slices (mints with a transfer hook program are refused upstream, see token.ts), then every
 * bin array covering the range (writable). Token programs come from the LbPair flags (SPL or Token-2022).
 */
export function meteoraAddLiquidityByStrategy2Instruction(input: MeteoraAddLiquidityInput) {
  const programId = input.programId ?? METEORA_DLMM_PROGRAM_ID;
  assertMeteoraOpenRange(input.minBinId, input.maxBinId, { withBitmapExtension: !!input.bitmapExtension });
  if (!Number.isInteger(input.maxActiveBinSlippage) || input.maxActiveBinSlippage < 0) throw new Error("Invalid active bin slippage");
  if (input.amountX === 0n && input.amountY === 0n) throw new Error("Meteora deposit is empty");
  const lbPair = input.lbPair.toBase58();
  const binArrays = meteoraBinArrayIndexesForRange(input.minBinId, input.maxBinId)
    .map((index) => ({ pubkey: new PublicKey(meteoraBinArrayAddress(lbPair, index, programId)), isSigner: false, isWritable: true }));
  const data = Buffer.concat([
    Buffer.from(METEORA_IX_DISCRIMINATOR.addLiquidityByStrategy2, "hex"),
    u64(input.amountX), u64(input.amountY), i32(input.activeId), i32(input.maxActiveBinSlippage),
    i32(input.minBinId), i32(input.maxBinId), Buffer.from([METEORA_STRATEGY_SPOT_IMBALANCED]), Buffer.alloc(64),
    Buffer.from([0, 0, 0, 0]), // RemainingAccountsInfo { slices: [] }
  ]);
  return new TransactionInstruction({
    programId: program(programId),
    keys: [
      { pubkey: input.position, isSigner: false, isWritable: true },
      { pubkey: input.lbPair, isSigner: false, isWritable: true },
      meteoraBitmapExtensionMeta(input.bitmapExtension, programId),
      { pubkey: input.userTokenX, isSigner: false, isWritable: true },
      { pubkey: input.userTokenY, isSigner: false, isWritable: true },
      { pubkey: input.reserveX, isSigner: false, isWritable: true },
      { pubkey: input.reserveY, isSigner: false, isWritable: true },
      { pubkey: input.tokenXMint, isSigner: false, isWritable: false },
      { pubkey: input.tokenYMint, isSigner: false, isWritable: false },
      { pubkey: input.sender, isSigner: true, isWritable: false },
      { pubkey: input.tokenXProgram, isSigner: false, isWritable: false },
      { pubkey: input.tokenYProgram, isSigner: false, isWritable: false },
      { pubkey: meteoraEventAuthority(programId), isSigner: false, isWritable: false },
      { pubkey: program(programId), isSigner: false, isWritable: false },
      ...binArrays,
    ],
    data,
  });
}

/** `close_position2`: closes an empty position and refunds its rent to `rentReceiver` (the owner). */
export function meteoraClosePosition2Instruction(input: { position: PublicKey; sender: PublicKey; rentReceiver: PublicKey; programId?: string }) {
  const programId = input.programId ?? METEORA_DLMM_PROGRAM_ID;
  return new TransactionInstruction({
    programId: program(programId),
    keys: [
      { pubkey: input.position, isSigner: false, isWritable: true },
      { pubkey: input.sender, isSigner: true, isWritable: false },
      { pubkey: input.rentReceiver, isSigner: false, isWritable: true },
      { pubkey: meteoraEventAuthority(programId), isSigner: false, isWritable: false },
      { pubkey: program(programId), isSigner: false, isWritable: false },
    ],
    data: Buffer.from(METEORA_IX_DISCRIMINATOR.closePosition2, "hex"),
  });
}

/** SDK rule: ceil(slippage% / (binStep / 100)) = ceil(slippageBps / binStep) bins. */
export function meteoraMaxActiveBinSlippage(slippageBps: number, binStep: number) {
  if (!(binStep > 0) || !(slippageBps >= 0)) throw new Error("Invalid slippage or bin step");
  return Math.ceil(slippageBps / binStep);
}

/**
 * Value share of a Spot deposit that goes to token X (bins above the active bin hold X, below hold Y, the
 * active bin holds both), as a fraction `xBins / totalBins` in half-bin units. Out of range: all X or all Y.
 */
export function meteoraSpotXShare(activeId: number, lowerBinId: number, upperBinId: number): { numerator: bigint; denominator: bigint } {
  if (lowerBinId > activeId) return { numerator: 1n, denominator: 1n };
  if (upperBinId < activeId) return { numerator: 0n, denominator: 1n };
  const xHalfBins = 2 * (upperBinId - activeId) + 1;
  const total = 2 * (upperBinId - lowerBinId + 1);
  return { numerator: BigInt(xHalfBins), denominator: BigInt(total) };
}

/** Splits `amount` (input units) into the X and Y value shares of a Spot deposit; X gets the floor. */
export function meteoraSpotSplit(amount: bigint, activeId: number, lowerBinId: number, upperBinId: number) {
  if (amount <= 0n) throw new Error("Deposit amount must be greater than zero");
  const share = meteoraSpotXShare(activeId, lowerBinId, upperBinId);
  const x = amount * share.numerator / share.denominator;
  return { x, y: amount - x };
}

/**
 * Bins each side of a SpotImBalanced deposit (`add_liquidity_by_strategy2`) fills: token X goes to every bin from the
 * active bin up to the upper bin, token Y to every bin below the active bin. Out of range: one side fills the whole range.
 */
export function meteoraSpotBinCounts(activeId: number, lowerBinId: number, upperBinId: number): { x: number; y: number } {
  const width = upperBinId - lowerBinId + 1;
  if (!(width > 0)) throw new Error("Invalid bin range");
  if (lowerBinId > activeId) return { x: width, y: 0 };
  if (upperBinId < activeId) return { x: 0, y: width };
  const x = upperBinId - activeId + 1;
  return { x, y: width - x };
}

/**
 * SpotImBalanced puts floor(amount / bins) raw units into each bin of a side, so a side whose amount is smaller than
 * its bin count adds nothing at all. True when any side that has bins would get 0 per bin.
 */
export function meteoraSpotRoundsToZero(amountX: bigint, amountY: bigint, bins: { x: number; y: number }): boolean {
  return (bins.x > 0 && amountX / BigInt(bins.x) < 1n) || (bins.y > 0 && amountY / BigInt(bins.y) < 1n);
}

/** One side's observed conversion: `spend` input raw units bought `out` pool-token raw units (after fees and slippage). */
export type MeteoraSideRate = { spend: bigint; out: bigint };

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

/**
 * Smallest input (raw units) for which every bin of the range gets at least 1 raw unit of its side, assuming each side's
 * output scales linearly with its spend (`rates`, e.g. from a Jupiter quote; a side kept as-is has out = spend). Uses the
 * same X/Y split as `meteoraSpotSplit`. Null when a side with bins has no usable rate (out = 0).
 */
export function meteoraSpotMinimumInput(input: {
  activeId: number; lowerBinId: number; upperBinId: number; rates: { x?: MeteoraSideRate; y?: MeteoraSideRate };
}): bigint | null {
  const bins = meteoraSpotBinCounts(input.activeId, input.lowerBinId, input.upperBinId);
  const share = meteoraSpotXShare(input.activeId, input.lowerBinId, input.upperBinId);
  let minimum = 1n;
  for (const side of ["x", "y"] as const) {
    const count = BigInt(bins[side]);
    if (count === 0n) continue;
    const rate = input.rates[side];
    if (!rate || rate.out <= 0n || rate.spend <= 0n) return null;
    // Spend on this side so that its output reaches `count` raw units (1 per bin).
    const sideSpend = ceilDiv(count * rate.spend, rate.out);
    const sideShare = side === "x" ? share.numerator : share.denominator - share.numerator;
    if (sideShare <= 0n) return null;
    // X takes floor(amount * num / den) and Y the rest; +1 covers the floor on either side.
    const total = ceilDiv(sideSpend * share.denominator, sideShare) + 1n;
    if (total > minimum) minimum = total;
  }
  return minimum;
}
