import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import { meteoraBinArrayAddress, meteoraBinArrayIndexesForRange } from "./accounts";
import { METEORA_DLMM_PROGRAM_ID } from "./constants";
import { assertMeteoraBinRange, meteoraBitmapExtensionMeta, meteoraEventAuthority } from "./open";

/**
 * Meteora DLMM withdraw and claim instructions (`remove_liquidity_by_range2`, `claim_fee2`), hand-encoded from
 * the `lb_clmm` IDL shipped with `@meteora-ag/dlmm` 1.9.14 (byte and account-order parity with the SDK's Anchor
 * coder is pinned in liquidity.test.ts). Build only: nothing here signs or sends, and nothing touches the
 * SoFinance fee wallet (claimed fees and withdrawn tokens go to the owner's own token accounts).
 */

/** sha256("global:<name>")[0..8]. */
export const METEORA_LIQUIDITY_IX_DISCRIMINATOR = Object.freeze({
  claimFee2: "70bf65ab1c907fbb",
  removeLiquidityByRange2: "cc02c391359191cd",
});

/** SPL Memo program: required by the Token-2022-aware `*2` instructions. */
export const METEORA_MEMO_PROGRAM_ID = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
/** `bps_to_remove` is out of 10,000 (100%). */
export const METEORA_BPS_MAX = 10_000;

const program = (programId: string) => new PublicKey(programId);

function i32(value: number) {
  const buffer = Buffer.alloc(4);
  buffer.writeInt32LE(value);
  return buffer;
}

function u16(value: number) {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16LE(value);
  return buffer;
}

/** RemainingAccountsInfo { slices: [] }: no transfer-hook accounts (mints with a hook program are refused). */
const NO_REMAINING_SLICES = Buffer.from([0, 0, 0, 0]);

function binArrayMetas(lbPair: PublicKey, lowerBinId: number, upperBinId: number, programId: string) {
  const pair = lbPair.toBase58();
  return meteoraBinArrayIndexesForRange(lowerBinId, upperBinId)
    .map((index) => ({ pubkey: new PublicKey(meteoraBinArrayAddress(pair, index, programId)), isSigner: false, isWritable: true }));
}

export type MeteoraPoolTokenAccounts = {
  lbPair: PublicKey; position: PublicKey; sender: PublicKey;
  /** The owner's token accounts (ATAs of the mint's own token program) that receive tokens. */
  userTokenX: PublicKey; userTokenY: PublicKey;
  reserveX: PublicKey; reserveY: PublicKey; tokenXMint: PublicKey; tokenYMint: PublicKey;
  /** From the LbPair flags (`meteoraPoolTokenPrograms`): SPL Token or Token-2022. */
  tokenXProgram: PublicKey; tokenYProgram: PublicKey;
  programId?: string;
};

/**
 * `remove_liquidity_by_range2(from, to, bps)`: withdraws `bps`/10,000 of the position's liquidity in
 * `[fromBinId, toBinId]` to the owner's token accounts. A full exit is bps = 10,000 over the whole position,
 * followed by `claim_fee2` and `close_position2` (rent back to the owner).
 */
export function meteoraRemoveLiquidityByRange2Instruction(input: MeteoraPoolTokenAccounts & {
  fromBinId: number; toBinId: number; bps: number; bitmapExtension?: PublicKey;
}) {
  const programId = input.programId ?? METEORA_DLMM_PROGRAM_ID;
  assertMeteoraBinRange(input.fromBinId, input.toBinId);
  if (!Number.isInteger(input.bps) || input.bps < 1 || input.bps > METEORA_BPS_MAX) throw new Error("Withdraw share must be between 1 and 10,000 bps");
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
      { pubkey: new PublicKey(METEORA_MEMO_PROGRAM_ID), isSigner: false, isWritable: false },
      { pubkey: meteoraEventAuthority(programId), isSigner: false, isWritable: false },
      { pubkey: program(programId), isSigner: false, isWritable: false },
      ...binArrayMetas(input.lbPair, input.fromBinId, input.toBinId, programId),
    ],
    data: Buffer.concat([
      Buffer.from(METEORA_LIQUIDITY_IX_DISCRIMINATOR.removeLiquidityByRange2, "hex"),
      i32(input.fromBinId), i32(input.toBinId), u16(input.bps), NO_REMAINING_SLICES,
    ]),
  });
}

/** `claim_fee2(min, max)`: sends the position's unclaimed swap fees in `[minBinId, maxBinId]` to the owner's token accounts. */
export function meteoraClaimFee2Instruction(input: MeteoraPoolTokenAccounts & { minBinId: number; maxBinId: number }) {
  const programId = input.programId ?? METEORA_DLMM_PROGRAM_ID;
  assertMeteoraBinRange(input.minBinId, input.maxBinId);
  return new TransactionInstruction({
    programId: program(programId),
    keys: [
      { pubkey: input.lbPair, isSigner: false, isWritable: true },
      { pubkey: input.position, isSigner: false, isWritable: true },
      { pubkey: input.sender, isSigner: true, isWritable: false },
      { pubkey: input.reserveX, isSigner: false, isWritable: true },
      { pubkey: input.reserveY, isSigner: false, isWritable: true },
      { pubkey: input.userTokenX, isSigner: false, isWritable: true },
      { pubkey: input.userTokenY, isSigner: false, isWritable: true },
      { pubkey: input.tokenXMint, isSigner: false, isWritable: false },
      { pubkey: input.tokenYMint, isSigner: false, isWritable: false },
      { pubkey: input.tokenXProgram, isSigner: false, isWritable: false },
      { pubkey: input.tokenYProgram, isSigner: false, isWritable: false },
      { pubkey: new PublicKey(METEORA_MEMO_PROGRAM_ID), isSigner: false, isWritable: false },
      { pubkey: meteoraEventAuthority(programId), isSigner: false, isWritable: false },
      { pubkey: program(programId), isSigner: false, isWritable: false },
      ...binArrayMetas(input.lbPair, input.minBinId, input.maxBinId, programId),
    ],
    data: Buffer.concat([
      Buffer.from(METEORA_LIQUIDITY_IX_DISCRIMINATOR.claimFee2, "hex"), i32(input.minBinId), i32(input.maxBinId), NO_REMAINING_SLICES,
    ]),
  });
}
