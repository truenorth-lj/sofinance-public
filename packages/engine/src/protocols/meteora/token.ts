import { getTransferHook, unpackMint, type Mint } from "@solana/spl-token";
import { PublicKey, type AccountInfo } from "@solana/web3.js";
import { mintHasTransferFee, mintIsPaused } from "../../token-safety";
import type { LbPairState } from "./accounts";
import { SPL_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "./constants";

/**
 * Token program selection and Token-2022 guards for Meteora DLMM pools (no SDK dependency). The RWA pools
 * (xStocks / Backpack) hold Token-2022 mints on both sides, so every instruction and ATA must use the program
 * the LbPair declares, and the open/add/withdraw paths must stop when a mint can no longer move freely.
 * Nothing here builds or signs transactions.
 */

/**
 * Why a Meteora pool mint blocks a transaction (DESIGN.md §7.7). Only these three; a permanent delegate or a
 * freeze authority is not a block reason and is not surfaced.
 * - `transfer_hook`: TransferHook has a program id (its extra accounts are not supported yet).
 * - `paused`: PausableConfig is paused (no transfers).
 * - `transfer_fee`: TransferFeeConfig charges more than 0 bps (older or newer epoch).
 */
export type MeteoraMintRestriction = "transfer_hook" | "paused" | "transfer_fee";

/** LbPair `token_mint_x_program_flag` / `_y_`: 0 = SPL Token, 1 = Token-2022. Anything else is rejected. */
export function meteoraTokenProgramForFlag(flag: number): string {
  if (flag === 0) return SPL_TOKEN_PROGRAM_ID;
  if (flag === 1) return TOKEN_2022_PROGRAM_ID;
  throw new Error("Unknown Meteora token program flag");
}

export function meteoraPoolTokenPrograms(state: Pick<LbPairState, "tokenProgramFlagX" | "tokenProgramFlagY">) {
  return { tokenProgramX: meteoraTokenProgramForFlag(state.tokenProgramFlagX), tokenProgramY: meteoraTokenProgramForFlag(state.tokenProgramFlagY) };
}

export function meteoraMintHasTransferHook(mint: Mint): boolean {
  const hook = getTransferHook(mint);
  return !!hook && !hook.programId.equals(PublicKey.default);
}

/** Every restriction of one mint in a fixed order (empty = transfers are unrestricted). */
export function meteoraMintRestrictions(mint: Mint): MeteoraMintRestriction[] {
  const reasons: MeteoraMintRestriction[] = [];
  if (meteoraMintHasTransferHook(mint)) reasons.push("transfer_hook");
  if (mintIsPaused(mint)) reasons.push("paused");
  if (mintHasTransferFee(mint)) reasons.push("transfer_fee");
  return reasons;
}

/**
 * Decodes a pool mint read fresh from chain and checks it against the program the LbPair declares.
 * Throws if the account is missing or owned by a different program; returns the mint and its restrictions.
 */
export function checkMeteoraPoolMint(address: string, info: AccountInfo<Buffer> | null, expectedProgram: string) {
  if (!info) throw new Error("Meteora pool token mint does not exist");
  if (info.owner.toBase58() !== expectedProgram) throw new Error("Meteora pool token mint program does not match the pool");
  const mint = unpackMint(new PublicKey(address), info, info.owner);
  return { mint, restrictions: meteoraMintRestrictions(mint) };
}
