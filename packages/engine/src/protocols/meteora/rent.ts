import { PublicKey, type Connection } from "@solana/web3.js";
import { BIN_ARRAY_ACCOUNT_LEN, meteoraBinArrayAddress, meteoraBinArrayIndexesForRange } from "./accounts";
import { METEORA_DLMM_PROGRAM_ID } from "./constants";
import { meteoraBitmapExtensionAddress, meteoraRangeNeedsBitmapExtension, METEORA_OPEN_MAX_WIDTH } from "./open";
import { METEORA_POSITION_BASE_BINS, METEORA_POSITION_BASE_LEN, METEORA_POSITION_MAX_BINS } from "./position";

/**
 * Live rent and shared-account checks for opening a Meteora DLMM position (read-only RPC; nothing is signed).
 * Amounts always come from `getMinimumBalanceForRentExemption` at quote time, never from hard-coded lamports
 * (the cluster's rent rate changes; the SDK's `POSITION_FEE` / `BIN_ARRAY_FEE` constants are already stale).
 */

/** Bytes appended per bin beyond the base 70 (`increase_position_length`). */
export const METEORA_POSITION_EXTRA_BIN_LEN = 112;

/** Account size of a position spanning `width` bins (base 8,120 bytes up to 70 bins). */
export function meteoraPositionAccountSize(width: number): number {
  if (!Number.isInteger(width) || width < 1 || width > METEORA_POSITION_MAX_BINS) throw new Error("Invalid Meteora position width");
  return METEORA_POSITION_BASE_LEN + Math.max(0, width - METEORA_POSITION_BASE_BINS) * METEORA_POSITION_EXTRA_BIN_LEN;
}

type RentReader = Pick<Connection, "getMinimumBalanceForRentExemption">;
type AccountsReader = Pick<Connection, "getMultipleAccountsInfo">;

/** Position rent (lamports) for a v1 open: refundable to the owner by `close_position2` on a full withdraw. */
export async function fetchMeteoraPositionRent(connection: RentReader, width: number) {
  if (width > METEORA_OPEN_MAX_WIDTH) throw new Error(`Meteora v1 positions span at most ${METEORA_OPEN_MAX_WIDTH} bins`);
  const lamports = await connection.getMinimumBalanceForRentExemption(meteoraPositionAccountSize(width));
  return { lamports: BigInt(lamports), refundableOnClose: true as const };
}

/** Rent (lamports) a new bin array would cost; shown for disclosure only, v1 never creates one. */
export async function fetchMeteoraBinArrayRent(connection: RentReader) {
  return BigInt(await connection.getMinimumBalanceForRentExemption(BIN_ARRAY_ACCOUNT_LEN));
}

export type MeteoraOpenAccounts = {
  /** Bin array indexes the range needs that do not exist yet (v1 refuses to open when non-empty). */
  missingBinArrayIndexes: number[];
  /** The range's bin arrays sit outside [-512, 511], so liquidity instructions must carry the bitmap extension. */
  needsBitmapExtension: boolean;
  /** The pool's bitmap extension PDA when it exists on chain, else null. */
  bitmapExtension: PublicKey | null;
};

/**
 * Which shared on-chain accounts an open over `[lowerBinId, upperBinId]` relies on, read in one
 * `getMultipleAccountsInfo` call: the bin arrays covering the range and the pool's bitmap extension.
 */
export async function readMeteoraOpenAccounts(
  connection: AccountsReader, lbPair: string, lowerBinId: number, upperBinId: number, programId = METEORA_DLMM_PROGRAM_ID,
): Promise<MeteoraOpenAccounts> {
  const indexes = meteoraBinArrayIndexesForRange(lowerBinId, upperBinId);
  const bitmap = meteoraBitmapExtensionAddress(lbPair, programId);
  const keys = [bitmap, ...indexes.map((index) => new PublicKey(meteoraBinArrayAddress(lbPair, index, programId)))];
  const infos = await connection.getMultipleAccountsInfo(keys);
  if (infos.length !== keys.length) throw new Error("RPC returned an unexpected number of accounts");
  const owned = (i: number) => !!infos[i] && infos[i]!.owner.toBase58() === programId;
  return {
    missingBinArrayIndexes: indexes.filter((_, i) => !owned(i + 1)),
    needsBitmapExtension: meteoraRangeNeedsBitmapExtension(lowerBinId, upperBinId),
    bitmapExtension: owned(0) ? bitmap : null,
  };
}
