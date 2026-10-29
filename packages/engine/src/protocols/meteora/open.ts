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

export function assertMeteoraOpenRange(lowerBinId: number, upperBinId: number) {
  if (!Number.isSafeInteger(lowerBinId) || !Number.isSafeInteger(upperBinId) || upperBinId < lowerBinId) {
    throw new Error("Invalid Meteora bin range");
  }
  const width = upperBinId - lowerBinId + 1;
  if (width > METEORA_OPEN_MAX_WIDTH) throw new Error(`Meteora v1 positions span at most ${METEORA_OPEN_MAX_WIDTH} bins`);
  if (meteoraRangeNeedsBitmapExtension(lowerBinId, upperBinId)) throw new Error("Meteora v1 does not open ranges that need the bitmap extension");
  return width;
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
};

/**
 * `add_liquidity_by_strategy2` with Spot (SpotImBalanced) over `[minBinId, maxBinId]`. Remaining accounts:
 * no transfer-hook slices (SPL mints only), then every bin array covering the range (writable).
 */
export function meteoraAddLiquidityByStrategy2Instruction(input: MeteoraAddLiquidityInput) {
  const programId = input.programId ?? METEORA_DLMM_PROGRAM_ID;
  assertMeteoraOpenRange(input.minBinId, input.maxBinId);
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
      // Optional bitmap extension absent: Anchor's placeholder is the program id.
      { pubkey: program(programId), isSigner: false, isWritable: false },
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
