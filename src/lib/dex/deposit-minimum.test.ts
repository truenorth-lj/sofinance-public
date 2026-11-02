import { describe, expect, it } from "vitest";
import { depositTooSmallMessage, suggestedMinimum } from "./deposit-minimum";

const USDC = { id: "usdc", decimals: 6, symbol: "USDC" };

describe("depositTooSmallMessage (shared by Open and Add)", () => {
  it("suggests the minimum plus 10%, rounded up to 2 significant figures, never below the estimate", () => {
    expect(suggestedMinimum(48_336n, 6)).toBe("0.054");
    expect(suggestedMinimum(100_000n, 6)).toBe("0.11");
    expect(suggestedMinimum(9n, 6)).toBe("0.00001");
    expect(suggestedMinimum(2_000_000n, 6)).toBe("2.2");
    expect(suggestedMinimum(0n, 6)).toBe("0");
  });

  it("says the amount is too small with the suggested minimum, only for the same token and only when too small", () => {
    expect(depositTooSmallMessage({ token: "usdc", tooSmall: true, minimumRaw: "48336" }, USDC))
      .toBe("This amount is too small to add to every price step in this range. Try at least about 0.054 USDC.");
    expect(depositTooSmallMessage({ token: "usdc", tooSmall: true, minimumRaw: null }, USDC))
      .toBe("This amount is too small to add to every price step in this range. Try a larger amount.");
    expect(depositTooSmallMessage({ token: "usdc", tooSmall: false, minimumRaw: null }, USDC)).toBeNull();
    expect(depositTooSmallMessage({ token: "other", tooSmall: true, minimumRaw: "48336" }, USDC)).toBeNull();
    expect(depositTooSmallMessage(undefined, USDC)).toBeNull();
    expect(depositTooSmallMessage({ token: "usdc", tooSmall: true, minimumRaw: "48336" }, { ...USDC, symbol: null }))
      .toBe("This amount is too small to add to every price step in this range. Try at least about 0.054.");
  });
});
