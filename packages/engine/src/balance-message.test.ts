import { describe, expect, it } from "vitest";
import { knownTokenSymbol, NOT_ENOUGH_SOL_FOR_FEES_MESSAGE, notEnoughBalanceMessage } from "./balance-message";
import { NATIVE_SOL_MINT, USDC_MINT } from "./ids";

describe("balance messages", () => {
  it("names the token and both amounts", () => {
    expect(notEnoughBalanceMessage({ symbol: "INTCy", decimals: 6, balance: 0n, requested: 10_957_663n }))
      .toBe("Not enough INTCy (you have 0, entered 10.957663)");
    expect(notEnoughBalanceMessage({ decimals: 6, balance: "1500000", requested: "2000000" }))
      .toBe("Not enough of this token in your wallet (you have 1.5, entered 2)");
  });
  it("keeps SOL fee shortfalls separate from token shortfalls", () => {
    expect(notEnoughBalanceMessage({ decimals: 9, balance: 50_000_000n, requested: 100_000_000n, native: true }))
      .toBe("Not enough SOL (you can use 0.05 SOL after keeping some for network fees, entered 0.1)");
    expect(NOT_ENOUGH_SOL_FOR_FEES_MESSAGE).toMatch(/^Not enough SOL for network fees/);
    expect(NOT_ENOUGH_SOL_FOR_FEES_MESSAGE).not.toMatch(/token balance/i);
  });
  it("knows only symbols it can be sure of", () => {
    expect(knownTokenSymbol(NATIVE_SOL_MINT, "native")).toBe("SOL");
    expect(knownTokenSymbol(NATIVE_SOL_MINT, "token")).toBe("WSOL");
    expect(knownTokenSymbol(USDC_MINT, "token")).toBe("USDC");
    expect(knownTokenSymbol("SomeOtherMint1111111111111111111111111111111", "token")).toBeNull();
  });
});
