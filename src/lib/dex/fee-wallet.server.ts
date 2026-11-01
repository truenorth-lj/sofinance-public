import "server-only";
import { captureDexMisconfiguration } from "@/lib/sentry/capture";
import { DexError } from "./errors";

/**
 * A fee-charging DEX operation with no fee wallet configured would silently charge 0. That is allowed only in unit tests
 * and local development; anywhere else (a Vercel production or preview deployment, or a local production build) the
 * operation is refused with a plain config error and reported to Sentry.
 */
export function zeroFeeAllowed(
  env: { VERCEL_ENV?: string; NODE_ENV?: string } = { VERCEL_ENV: process.env.VERCEL_ENV, NODE_ENV: process.env.NODE_ENV },
): boolean {
  if (env.VERCEL_ENV === "production" || env.VERCEL_ENV === "preview") return false;
  return env.NODE_ENV === "test" || env.NODE_ENV === "development";
}

export const FEE_WALLET_MISSING_MESSAGE =
  "Opening positions is temporarily unavailable because the platform fee settings are incomplete. Nothing was prepared; please try again later.";

/** Throws a MISCONFIGURED DexError (and reports it) when `charges` and no fee wallet is set, unless a 0 fee is allowed. */
export function assertFeeWalletConfigured(input: { dexId: string; op: string; charges: boolean; feeWallet: string | null }): void {
  if (!input.charges || input.feeWallet || zeroFeeAllowed()) return;
  captureDexMisconfiguration(input.dexId, input.op, "fee_wallet_missing");
  throw new DexError("MISCONFIGURED", FEE_WALLET_MISSING_MESSAGE);
}
