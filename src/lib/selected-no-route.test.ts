import { describe, expect, it } from "vitest";
import { USDC_MINT } from "@sofinance/engine/ids";
import {
  formatSelectedNoRouteMessage, JUPITER_NO_ROUTE_CODE, selectedNoRouteError, selectedNoRouteOutputMint,
} from "./selected-no-route";

describe("selected no-route message", () => {
  it("names the input and the in-range base pool token", () => {
    const error = selectedNoRouteError({
      inputMint: "spcx-mint", inputKind: "token", mintA: "intc-mint", mintB: "intcx-mint", rangeSide: "inside",
    });
    expect(error.code).toBe(JUPITER_NO_ROUTE_CODE);
    expect(error.outputMint).toBe("intc-mint");
    expect(error.message).toBe(formatSelectedNoRouteMessage("spcx…mint", "intc…mint"));
    expect(error.message).toMatch(/Try USDC, SOL, or one of the pool's tokens/);
  });

  it("uses SOL and USDC labels when those are the assets", () => {
    const error = selectedNoRouteError({
      inputMint: USDC_MINT, inputKind: "token", mintA: "a", mintB: "b", rangeSide: "below",
    });
    expect(error.message).toBe(formatSelectedNoRouteMessage("USDC", "a"));
    expect(selectedNoRouteOutputMint({
      inputMint: USDC_MINT, inputKind: "native", mintA: "a", mintB: "b", rangeSide: "above",
    })).toBe("b");
  });
});
