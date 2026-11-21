import { describe, expect, it } from "vitest";
import { addWalletPreviewSplit } from "./add-wallet-preview";

const quote = { requiredA: "150000000", requiredB: "2000000", dustA: "1000000", dustB: "500000", decimalsA: 8, decimalsB: 6 };

describe("addWalletPreviewSplit", () => {
  it("values the tolerance reserve as coming back and the required amounts as going into the position", () => {
    // A: 1.5 deposited + 0.01 back at $40; B: 2 deposited + 0.5 back at $1.
    expect(addWalletPreviewSplit(quote, { usdPerRawUnitA: 40, usdPerRawUnitB: 1 })).toEqual({ backUsd: 0.9, depositUsd: 62 });
  });
  it("is left out when a token has no USD price", () => {
    expect(addWalletPreviewSplit(quote, { usdPerRawUnitA: 40, usdPerRawUnitB: null })).toBeNull();
    expect(addWalletPreviewSplit(quote, undefined)).toBeNull();
  });
  it("is left out when a token's USD price is 0, the same as missing", () => {
    expect(addWalletPreviewSplit(quote, { usdPerRawUnitA: 0, usdPerRawUnitB: 1 })).toBeNull();
    expect(addWalletPreviewSplit(quote, { usdPerRawUnitA: 40, usdPerRawUnitB: 0 })).toBeNull();
  });
  it("uses USD per raw unit as given: a ×2 scaled side is not multiplied again", () => {
    // A is a ×2 scaled stock at $20 per share: $40 per raw unit, the same split as the plain case above.
    expect(addWalletPreviewSplit(quote, { usdPerRawUnitA: 40, usdPerRawUnitB: 1 })).toEqual({ backUsd: 0.9, depositUsd: 62 });
  });
});
