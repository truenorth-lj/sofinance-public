import "server-only";
import { captureDexMisconfiguration } from "@/lib/sentry/capture";
import { DexError } from "./errors";

/**
 * A fee-charging DEX operation with no fee wallet configured is refused in every environment (production, preview,
 * local dev and tests alike) with a plain config error, reported to Sentry, and nothing is built. There is no silent
 * 0 fee: a test or local setup that wants no fee must pass an explicit fee policy of "none" for that operation.
 */
export const FEE_WALLET_MISSING_MESSAGE =
  "Opening positions is temporarily unavailable because the platform fee settings are incomplete. Nothing was prepared; please try again later.";

/** Throws a MISCONFIGURED DexError (and reports it) when the operation `charges` and no fee wallet is set. */
export function assertFeeWalletConfigured(input: { dexId: string; op: string; charges: boolean; feeWallet: string | null }): void {
  if (!input.charges || input.feeWallet) return;
  captureDexMisconfiguration(input.dexId, input.op, "fee_wallet_missing");
  throw new DexError("MISCONFIGURED", FEE_WALLET_MISSING_MESSAGE);
}
