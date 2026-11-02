import { describe, expect, it } from "vitest";
import { openSolNeed, openSolPartsFromQuote, openSolShortfall, SOL_NEED_UNKNOWN_COPY, type OpenSolParts } from "./sol-need";

describe("openSolNeed (shared by the server's INSUFFICIENT_FUNDS check and the open dialog)", () => {
  const result = openSolPartsFromQuote(43_939_120n, { networkFeeLamports: "15000", swapAccountsLamports: "4245880", reserveLamports: "10000000" });
  const parts = (result as { ok: true; parts: OpenSolParts }).parts;
  it("adds rent, network fees, swap accounts and the reserve", () => {
    expect(openSolNeed(parts)).toBe(58_200_000n);
  });
  it("near miss: 0.0566 SOL against 0.0582 needed is 0.0016 SOL short; enough is 0", () => {
    expect(openSolShortfall(56_600_000n, parts)).toBe(1_600_000n);
    expect(openSolShortfall(58_200_000n, parts)).toBe(0n);
  });
  it("uses the full formula: rent + network fees + temporary swap accounts + reserve", () => {
    expect(result).toEqual({ ok: true, parts: { rentLamports: 43_939_120n, networkFeeLamports: 15_000n, swapAccountsLamports: 4_245_880n, reserveLamports: 10_000_000n } });
  });
  it("a quote without SOL parts can't be computed (never falls back to rent only)", () => {
    expect(openSolPartsFromQuote(43_939_120n, undefined)).toEqual({ ok: false, reason: SOL_NEED_UNKNOWN_COPY });
    expect(SOL_NEED_UNKNOWN_COPY).toContain("temporary swap accounts");
  });
  it("a quote with a missing or malformed SOL part can't be computed either (no part counts as 0)", () => {
    const base = { networkFeeLamports: "15000", swapAccountsLamports: "4245880", reserveLamports: "10000000" };
    for (const sol of [{ ...base, swapAccountsLamports: undefined }, { ...base, networkFeeLamports: "" }, { ...base, reserveLamports: "-1" }, { ...base, swapAccountsLamports: "1.5" }]) {
      expect(openSolPartsFromQuote(43_939_120n, sol as never).ok).toBe(false);
    }
  });
});
