import { describe, expect, it } from "vitest";
import { JupiterHttpError } from "@sofinance/engine/jupiter/errors";
import {
  AMOUNT_TOO_SMALL_CODE,
  AMOUNT_TOO_SMALL_MESSAGE,
  AmountTooSmallError,
  isJupiterAmountTooSmallHttp,
  JUPITER_CLIENT_ERROR_CODE,
  jupiterClientErrorMessage,
  minJupiterSwapAmount,
  quoteErrorHidesRecalculate,
} from "./selected-amount-error";

describe("selected amount-too-small mapping", () => {
  it("requires 200 raw units at 50 bps so Jupiter can compute a threshold", () => {
    expect(minJupiterSwapAmount(50)).toBe(200n);
    expect(minJupiterSwapAmount(1)).toBe(10_000n);
  });

  it("detects Jupiter's dust-threshold 400 body", () => {
    const error = new JupiterHttpError(400, "/swap/v1/quote", null,
      "Cannot compute other amount threshold, with amount 1 and slippageBps 50");
    expect(isJupiterAmountTooSmallHttp(error)).toBe(true);
    expect(new AmountTooSmallError()).toMatchObject({
      name: "AmountTooSmallError", code: AMOUNT_TOO_SMALL_CODE, message: AMOUNT_TOO_SMALL_MESSAGE,
    });
    expect(isJupiterAmountTooSmallHttp(new JupiterHttpError(400, "/swap/v1/quote", null, "CANNOT_COMPUTE_OTHER_AMOUNT_THRESHOLD"))).toBe(true);
    expect(isJupiterAmountTooSmallHttp(new JupiterHttpError(400, "/swap/v1/quote", null, "Token not tradable"))).toBe(false);
  });

  it("surfaces the Jupiter body for remaining 400s and hides Recalculate for typed quote failures", () => {
    expect(jupiterClientErrorMessage(new JupiterHttpError(400, "/swap/v1/quote", null, "Token not tradable")))
      .toBe("Token not tradable");
    expect(jupiterClientErrorMessage(new JupiterHttpError(400, "/swap/v1/quote"))).toBe("Jupiter rejected this quote.");
    expect(quoteErrorHidesRecalculate("jupiter_no_route")).toBe(true);
    expect(quoteErrorHidesRecalculate(AMOUNT_TOO_SMALL_CODE)).toBe(true);
    expect(quoteErrorHidesRecalculate(JUPITER_CLIENT_ERROR_CODE)).toBe(true);
    expect(quoteErrorHidesRecalculate("")).toBe(false);
    expect(quoteErrorHidesRecalculate("jupiter_unavailable")).toBe(false);
  });
});
