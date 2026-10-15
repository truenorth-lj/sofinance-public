import { describe, expect, it } from "vitest";
import { compoundCost, formatUsdcValue } from "./compound-cost";
import type { CompoundSummary } from "@sofinance/engine/compound-types";

const summary = (patch: Partial<CompoundSummary> = {}) => ({
  feeLamports: 5000, rentLamports: 6156960, swaps: [],
  state: { mintA: "A", mintB: "B", pricing: { priceUsdA: 100, priceUsdB: 100 } }, ...patch,
}) as CompoundSummary;

describe("compound expenses", () => {
  it("excludes refundable rent and includes tips and fee-recipient setup", () => {
    const cost = compoundCost(summary({ nonRefundableRentLamports: "2000000", beam: { included: true, tipLamports: 10000, tipAddress: "tip", skippedReason: null } }), 150, 1);
    expect(cost.totalSol).toBe(0.002015);
    expect(cost.totalUsdc).toBeCloseTo(0.30225);
  });
  it("includes both pool and platform token fees without counting the swap principal", () => {
    const swaps = [{ inputMint: "A", inputDecimals: 6, inputAmount: "1000000", poolFeeAmount: "1000", feeAmount: "2000" }] as CompoundSummary["swaps"];
    const cost = compoundCost(summary({ swaps }), 150, 0.99);
    expect(cost.totalUsdc).toBeCloseTo(0.00075 + 0.3 / 0.99);
    expect(cost.totalSol).toBeCloseTo(cost.totalUsdc! / 150);
  });
  it("does not present a complete total when historical pool fees or token prices are missing", () => {
    const swaps = [{ inputMint: "A", inputDecimals: 6, feeAmount: "2000" }] as CompoundSummary["swaps"];
    expect(compoundCost(summary({ swaps }), 150, 1).totalUsdc).toBeNull();
    swaps![0]!.poolFeeAmount = "1000";
    expect(compoundCost(summary({ swaps, state: { mintA: "A" } as CompoundSummary["state"] }), 150, 1).totalSol).toBeNull();
    expect(compoundCost(summary(), null, null).totalSol).toBe(0.000005);
    expect(compoundCost(summary(), null, null).totalUsdc).toBeNull();
  });
  it("keeps small harvest values and zero distinguishable", () => {
    expect(formatUsdcValue(0.000687)).toBe("0.000687 USDC");
    expect(formatUsdcValue(0)).toBe("0 USDC");
    expect(formatUsdcValue(null)).toBe("USDC estimate unavailable");
  });
});
