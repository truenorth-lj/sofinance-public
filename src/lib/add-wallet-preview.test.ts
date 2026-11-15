import { describe, expect, it } from "vitest";
import { addWalletPreviewSplit } from "./add-wallet-preview";

const quote = { requiredA: "150000000", requiredB: "2000000", dustA: "1000000", dustB: "500000", decimalsA: 8, decimalsB: 6 };

describe("addWalletPreviewSplit", () => {
  it("values the tolerance reserve as coming back and the required amounts as going into the position", () => {
    // A: 1.5 deposited + 0.01 back at $40; B: 2 deposited + 0.5 back at $1.
    expect(addWalletPreviewSplit(quote, { priceUsdA: 40, priceUsdB: 1 })).toEqual({ backUsd: 0.9, depositUsd: 62 });
  });
  it("is left out when a token has no USD price", () => {
    expect(addWalletPreviewSplit(quote, { priceUsdA: 40, priceUsdB: null })).toBeNull();
    expect(addWalletPreviewSplit(quote, undefined)).toBeNull();
  });
});
