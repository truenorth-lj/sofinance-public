import { describe, expect, it } from "vitest";
import {
  annualizeSimplePct,
  computePositionPerformance,
  holdingDaysFromSeconds,
  sideUsd,
} from "./position-performance-math";

describe("position-performance-math", () => {
  it("converts holding seconds to days", () => {
    expect(holdingDaysFromSeconds(86_400)).toBe(1);
    expect(holdingDaysFromSeconds(0)).toBeNull();
    expect(holdingDaysFromSeconds(-1)).toBeNull();
  });

  it("annualizes with simple ×365/days", () => {
    expect(annualizeSimplePct(10, 36.5)).toBeCloseTo(100, 8);
    expect(annualizeSimplePct(null, 10)).toBeNull();
    expect(annualizeSimplePct(10, 0)).toBeNull();
  });

  it("values both sides in USD", () => {
    // 1.5 tokenA (6 dec) @ $2 + 3 tokenB (6 dec) @ $1 = 6
    expect(sideUsd({ a: 1_500_000n, b: 3_000_000n }, 6, 6, 2, 1)).toBeCloseTo(6, 8);
    expect(sideUsd({ a: 1n, b: 1n }, 6, 6, null, 1)).toBeNull();
  });

  it("computes HPR, annualized return, and fee-only APR from labeled cashflows", () => {
    // Deposit 100 USDC-equivalent (token B only), hold 10 days.
    // Earn 1 USDC fees collected + 1 uncollected; liquidity still 100 USDC; no IL.
    const metrics = computePositionPerformance({
      deposited: { a: 0n, b: 100_000_000n },
      withdrawnPrincipal: { a: 0n, b: 0n },
      feesCollected: { a: 0n, b: 1_000_000n },
      liquidityAmounts: { a: 0n, b: 100_000_000n },
      uncollectedFees: { a: 0n, b: 1_000_000n },
      holdingSeconds: 10 * 86_400,
      priceUsdA: 1,
      priceUsdB: 1,
      decimalsA: 6,
      decimalsB: 6,
    });

    expect(metrics.holdingDays).toBe(10);
    expect(metrics.depositedUsd).toBeCloseTo(100, 8);
    expect(metrics.feesEarnedUsd).toBeCloseTo(2, 8);
    expect(metrics.currentEquityUsd).toBeCloseTo(101, 8);
    // pnl = equity 101 + withdrawn 0 + feesCollected 1 - deposited 100 = 2
    expect(metrics.pnlUsd).toBeCloseTo(2, 8);
    expect(metrics.holdingPeriodReturnPct).toBeCloseTo(2, 8);
    expect(metrics.annualizedReturnPct).toBeCloseTo(73, 8); // 2% * 365/10
    expect(metrics.feeOnlyAprPct).toBeCloseTo(73, 8); // 2/100 * 365/10 * 100
    expect(metrics.assumptions.length).toBeGreaterThan(20);
    expect(metrics.method).toContain("CreatePersonalPositionEvent");
  });

  it("returns null USD metrics when prices missing", () => {
    const metrics = computePositionPerformance({
      deposited: { a: 10n, b: 10n },
      withdrawnPrincipal: { a: 0n, b: 0n },
      feesCollected: { a: 0n, b: 0n },
      liquidityAmounts: { a: 10n, b: 10n },
      uncollectedFees: { a: 1n, b: 0n },
      holdingSeconds: 86_400,
      decimalsA: 6,
      decimalsB: 6,
    });
    expect(metrics.pnlUsd).toBeNull();
    expect(metrics.holdingPeriodReturnPct).toBeNull();
    expect(metrics.feeOnlyAprPct).toBeNull();
    expect(metrics.feesEarnedRaw.a).toBe("1");
  });
});
