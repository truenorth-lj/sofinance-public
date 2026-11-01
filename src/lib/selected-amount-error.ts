import "@/lib/engine-host";

import { SLIPPAGE_BPS } from "@sofinance/engine/ids";
import { JupiterHttpError, JUPITER_NO_ROUTE_CODE } from "@sofinance/engine/jupiter/errors";

export const AMOUNT_TOO_SMALL_CODE = "amount_too_small";
export const AMOUNT_TOO_SMALL_MESSAGE =
  "Amount too small to swap into this position — try a larger amount";
export const JUPITER_CLIENT_ERROR_CODE = "jupiter_client_error";

/** What the server knows about a genuine too-small amount; the UI turns it into a sentence with token names. */
export type AmountTooSmallDetail = {
  /** Smallest input (raw units of the input asset) that can cover every swap leg this position needs. */
  minimumInput: string;
  inputDecimals: number;
  /** Pool token whose swap leg is too small to quote. */
  minorityMint: string;
  /** Pool token the position needs almost all of (set when the position is nearly one-sided). */
  majorityMint?: string;
};

export type AmountTooSmallLabels = { input: string; minority: string; majority?: string; minimum: string };

/** Plain-English real cause for a genuine too-small amount, with the computed minimum. */
export function formatAmountTooSmallMessage(labels: AmountTooSmallLabels): string {
  const enter = `Enter at least ${labels.minimum} ${labels.input}.`;
  if (labels.majority) {
    return `This position's price range is narrow and the pool price sits at its edge, so it needs almost only ${labels.majority}. ` +
      `The ${labels.minority} part of this amount is below the smallest swap Jupiter can quote. ${enter}`;
  }
  return `This amount is below the smallest swap Jupiter can quote for the ${labels.minority} part. ${enter}`;
}

export class AmountTooSmallError extends Error {
  readonly code = AMOUNT_TOO_SMALL_CODE;
  readonly detail?: AmountTooSmallDetail;
  constructor(detail?: AmountTooSmallDetail, message = AMOUNT_TOO_SMALL_MESSAGE) {
    super(message);
    this.name = "AmountTooSmallError";
    this.detail = detail;
  }
}

export const SMALL_LEG_MOVES_PRICE_CODE = "small_leg_moves_price";

/**
 * Plain-English cause and next step when the in-range add needs a tiny swap into one pool token and even the smallest
 * swap Jupiter can quote would move this pool's price too far (out of the range, or past where its liquidity changes).
 */
export function formatSmallLegMovesPriceMessage(labels: { minority: string; majority: string }): string {
  return `This position's price range is narrow and the pool price sits at its edge, so it needs almost only ${labels.majority}. ` +
    `The pool is so thin there that even the smallest ${labels.minority} swap Jupiter can quote would push its price out of ` +
    `that spot. Nothing was sent. Try again after the price moves further inside the range, or use a position with a wider range.`;
}

export class SmallLegMovesPriceError extends Error {
  readonly code = SMALL_LEG_MOVES_PRICE_CODE;
  constructor(readonly detail: { minorityMint: string; majorityMint: string }, message: string) {
    super(message);
    this.name = "SmallLegMovesPriceError";
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
