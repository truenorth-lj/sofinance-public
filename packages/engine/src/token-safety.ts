import { AccountState, getDefaultAccountState, getPausableConfig, getTransferFeeConfig, type Mint } from "@solana/spl-token";

/**
 * Why a mint makes a pool unusable, shared by the open path and the RWA scan (SCAN_DESIGN.md §6.4, PM Q3):
 * - `paused`: Token-2022 PausableConfig is paused (no transfers).
 * - `transfer_fee`: Token-2022 TransferFeeConfig charges a fee (older or newer epoch fee above 0 bps).
 * - `frozen`: DefaultAccountState is Frozen (new token accounts start frozen).
 * A freeze authority on its own is not a block reason.
 */
export type MintBlockReason = "paused" | "transfer_fee" | "frozen";

export function mintIsPaused(mint: Mint): boolean {
  return getPausableConfig(mint)?.paused === true;
}

export function mintHasTransferFee(mint: Mint): boolean {
  const config = getTransferFeeConfig(mint);
  return !!config && (config.newerTransferFee.transferFeeBasisPoints > 0 || config.olderTransferFee.transferFeeBasisPoints > 0);
}

export function mintDefaultFrozen(mint: Mint): boolean {
  return getDefaultAccountState(mint)?.state === AccountState.Frozen;
}

/** Every block reason of one mint, in a fixed order (empty = not blocked). */
export function mintBlockReasons(mint: Mint): MintBlockReason[] {
  const reasons: MintBlockReason[] = [];
  if (mintIsPaused(mint)) reasons.push("paused");
  if (mintHasTransferFee(mint)) reasons.push("transfer_fee");
  if (mintDefaultFrozen(mint)) reasons.push("frozen");
  return reasons;
}
