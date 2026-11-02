import { describe, expect, it } from "vitest";
import { openSolNeed, openSolPartsFromQuote, openSolShortfall } from "./sol-need";

describe("openSolNeed (shared by the server's INSUFFICIENT_FUNDS check and the open dialog)", () => {
  const parts = openSolPartsFromQuote(43_939_120n, { networkFeeLamports: "15000", swapAccountsLamports: "4245880", reserveLamports: "10000000" });
  it("adds rent, network fees, swap accounts and the reserve", () => {
    expect(openSolNeed(parts)).toBe(58_200_000n);
  });
  it("near miss: 0.0566 SOL against 0.0582 needed is 0.0016 SOL short; enough is 0", () => {
    expect(openSolShortfall(56_600_000n, parts)).toBe(1_600_000n);
    expect(openSolShortfall(58_200_000n, parts)).toBe(0n);
  });
  it("a quote without SOL parts counts the rent only", () => {
    expect(openSolNeed(openSolPartsFromQuote(5n, undefined))).toBe(5n);
  });
});
