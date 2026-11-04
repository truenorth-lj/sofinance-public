import {
  AccountState, ExtensionType, getDefaultAccountState, getExtensionTypes, getPausableConfig, getScaledUiAmountConfig,
  getTransferFeeConfig, getTransferHook, type Mint,
} from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";

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

/** Token-2022 extensions a pool mint may carry and still be opened / managed here. */
const SUPPORTED_POOL_EXTENSIONS = new Set([
  ExtensionType.MintCloseAuthority, ExtensionType.PermanentDelegate, ExtensionType.PausableConfig,
  ExtensionType.MetadataPointer, ExtensionType.TokenMetadata, ExtensionType.GroupPointer,
  ExtensionType.TokenGroup, ExtensionType.GroupMemberPointer, ExtensionType.TokenGroupMember,
  ExtensionType.DefaultAccountState, ExtensionType.ConfidentialTransferMint,
  ExtensionType.TransferHook, ExtensionType.ScaledUiAmountConfig,
]);

/**
 * Settings of a pool mint the open / manage paths do not handle yet (their `unsupportedExtensions`; empty = fine), e.g.
 * "ScaledUiAmount multiplier not 1" (a balance multiplier, NVDAx). The pool list uses the same rule to grey out Open.
 */
export function poolMintIssues(mint: Mint): string[] {
  const extensions = getExtensionTypes(mint.tlvData);
  const issues = extensions.filter((extension) => !SUPPORTED_POOL_EXTENSIONS.has(extension))
    .map((extension) => ExtensionType[extension] || String(extension));
  if (extensions.includes(ExtensionType.DefaultAccountState) && getDefaultAccountState(mint)?.state !== AccountState.Initialized) {
    issues.push("DefaultAccountState not Initialized");
  }
  const hook = getTransferHook(mint);
  if (hook?.programId && !hook.programId.equals(PublicKey.default)) issues.push("TransferHook enabled");
  const scaled = getScaledUiAmountConfig(mint);
  if (scaled && (scaled.multiplier !== 1 || scaled.newMultiplier !== 1)) issues.push("ScaledUiAmount multiplier not 1");
  return issues;
}
