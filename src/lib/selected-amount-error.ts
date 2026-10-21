import "@/lib/engine-host";

import { SLIPPAGE_BPS } from "@sofinance/engine/ids";
import { JupiterHttpError, JUPITER_NO_ROUTE_CODE } from "@sofinance/engine/jupiter/errors";

export const AMOUNT_TOO_SMALL_CODE = "amount_too_small";
export const AMOUNT_TOO_SMALL_MESSAGE =
  "Amount too small to swap into this position — try a larger amount";
export const JUPITER_CLIENT_ERROR_CODE = "jupiter_client_error";

export class AmountTooSmallError extends Error {
  readonly code = AMOUNT_TOO_SMALL_CODE;
  constructor() {
    super(AMOUNT_TOO_SMALL_MESSAGE);
    this.name = "AmountTooSmallError";
  }
}

/** Smallest ExactIn size Jupiter can threshold at `slippageBps` (integer `amount * bps / 10000`). */
export function minJupiterSwapAmount(slippageBps = SLIPPAGE_BPS): bigint {
  if (!Number.isInteger(slippageBps) || slippageBps <= 0) return 1n;
  return (10_000n + BigInt(slippageBps) - 1n) / BigInt(slippageBps);
}

export function isJupiterAmountTooSmallHttp(error: unknown): boolean {
  if (!(error instanceof JupiterHttpError) || error.status !== 400) return false;
  const text = error.bodyError ?? "";
  return /cannot compute other amount threshold|cannot_compute_other_amount_threshold/i.test(text);
}

export function isAmountTooSmallError(error: unknown): boolean {
  return error instanceof AmountTooSmallError || isJupiterAmountTooSmallHttp(error);
}

export function jupiterClientErrorMessage(error: JupiterHttpError): string {
  const body = error.bodyError?.replace(/\s+/g, " ").trim();
  return body || "Jupiter rejected this quote.";
}

export function quoteErrorHidesRecalculate(code: string): boolean {
  return code === JUPITER_NO_ROUTE_CODE || code === AMOUNT_TOO_SMALL_CODE || code === JUPITER_CLIENT_ERROR_CODE;
}
