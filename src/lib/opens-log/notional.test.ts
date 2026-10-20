import { describe, expect, it } from "vitest";
import { USDC_MINT } from "@sofinance/engine/ids";
import { notionalUsdFromQuote } from "./notional";

describe("open notional", () => {
  it("converts USDC requested amounts and leaves other mints unknown", () => {
    expect(notionalUsdFromQuote({ inputMint: USDC_MINT, inputDecimals: 6, requested: "1500000" })).toBe(1.5);
    expect(notionalUsdFromQuote({ inputMint: "So11111111111111111111111111111111111111112", inputDecimals: 9, requested: "1000000000" })).toBeNull();
  });
});
