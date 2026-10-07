import { describe, expect, it } from "vitest";
import {
  annualizeSimplePct,
  computePositionPerformance,
  computeTokenEquivalentSnapshot,
  computeTokenNativeMetrics,
  holdingDaysFromSeconds,
  sideUsd,
  toTokenEquivalentUi,
  uiPriceBPerAFromTick,
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

describe("token-native / token-equivalent", () => {
  it("computes uiPriceBPerA from tick with decimal adjustment", () => {
    // tick 0 → price 1 * 10^(6-8) = 0.01
    expect(uiPriceBPerAFromTick(0, 6, 8)).toBeCloseTo(0.01, 12);
    // SPCX analysis tick
    const price = uiPriceBPerAFromTick(46054, 6, 8);
    expect(price).toBeCloseTo(0.9999995593616806, 10);
  });

  it("converts A+B into TE in A or B", () => {
    const price = 2; // 2 B per 1 A
    expect(toTokenEquivalentUi({ a: 3, b: 4 }, price, "A")).toBeCloseTo(3 + 4 / 2, 12);
    expect(toTokenEquivalentUi({ a: 3, b: 4 }, price, "B")).toBeCloseTo(3 * 2 + 4, 12);
  });

  it("matches SPCX-style fee-only APR and annualized return in base TE", () => {
    // Reproduce summary-token-native.json cashflows (UI) with same tick/decimals.
    const holdingDays = 10.05175925925926;
    const deposited = { a: 14.248041, b: 7.47488907 };
    const feesCollected = { a: 0.081615, b: 0.08030047 };
    const uncollectedFees = { a: 0.003955, b: 0.00431845 };
    const liquidityAmounts = { a: 17.15381, b: 4.56802074 };
    const feesEarned = {
      a: feesCollected.a + uncollectedFees.a,
      b: feesCollected.b + uncollectedFees.b,
    };
    const currentEquity = {
      a: liquidityAmounts.a + uncollectedFees.a,
      b: liquidityAmounts.b + uncollectedFees.b,
    };
    const amounts = {
      deposited,
      withdrawnPrincipal: { a: 0, b: 0 },
      feesCollected,
      uncollectedFees,
      feesEarned,
      liquidityAmounts,
      currentEquity,
      pnl: {
        a: currentEquity.a + 0 + feesCollected.a - deposited.a,
        b: currentEquity.b + 0 + feesCollected.b - deposited.b,
      },
    };
    const uiPrice = uiPriceBPerAFromTick(46054, 6, 8);
    const snap = computeTokenEquivalentSnapshot(amounts, uiPrice, "A", holdingDays);
    expect(snap.deposited).toBeCloseTo(21.72293336372401, 8);
    expect(snap.feesEarned).toBeCloseTo(0.17018895728635514, 8);
    expect(snap.equity).toBeCloseTo(21.730106204748743, 8);
    expect(snap.pnl).toBeCloseTo(0.1690883464082127, 6);
    expect(snap.holdingPeriodReturnPct).toBeCloseTo(0.7783863421069092, 6);
    expect(snap.annualizedReturnPct).toBeCloseTo(28.264804950169363, 4);
    expect(snap.feeOnlyAprPct).toBeCloseTo(28.44878304480179, 4);
  });

  it("builds tokenNative bundle preferring plain/base TE for wrap pairs", () => {
    const scaleA = 10n ** 6n;
    const scaleB = 10n ** 8n;
    const metrics = computeTokenNativeMetrics({
      deposited: { a: 14_248_041n, b: 747_488_907n },
      withdrawnPrincipal: { a: 0n, b: 0n },
      feesCollected: { a: 81_615n, b: 8_030_047n },
      liquidityAmounts: { a: 17_153_810n, b: 456_802_074n },
      uncollectedFees: { a: 3_955n, b: 431_845n },
      holdingDays: 10.05175925925926,
      decimalsA: 6,
      decimalsB: 8,
      tickCurrent: 46054,
      symbolA: "SPCX",
      symbolB: "SPCXx",
      sameAssetWrap: true,
      wrapKind: "suffix-x",
      wrappedSide: "B",
      plainSymbol: "SPCX",
      wrappedSymbol: "SPCXx",
    });
    expect(metrics.sameAssetWrap).toBe(true);
    expect(metrics.tokenEquivalent?.baseSide).toBe("A");
    expect(metrics.tokenEquivalent?.baseSymbol).toBe("SPCX");
    expect(metrics.tokenEquivalent?.metrics.feeOnlyAprPct).toBeCloseTo(28.44878304480179, 3);
    expect(metrics.perSideFeeAprPct.a).toBeCloseTo(21.808066440922975, 3);
    expect(metrics.perSideFeeAprPct.b).toBeCloseTo(41.10678503833252, 3);
    // raw sides preserved
    expect(metrics.amounts.deposited.a).toBeCloseTo(14.248041, 6);
    expect(metrics.amounts.deposited.b).toBeCloseTo(7.47488907, 6);
    void scaleA;
    void scaleB;
  });

  it("omits TE when not a same-asset wrap pair", () => {
    const metrics = computeTokenNativeMetrics({
      deposited: { a: 1_000_000n, b: 1_000_000n },
      withdrawnPrincipal: { a: 0n, b: 0n },
      feesCollected: { a: 0n, b: 0n },
      liquidityAmounts: { a: 1_000_000n, b: 1_000_000n },
      uncollectedFees: { a: 0n, b: 0n },
      holdingDays: 10,
      decimalsA: 6,
      decimalsB: 6,
      tickCurrent: 0,
      symbolA: "SOL",
      symbolB: "USDC",
      sameAssetWrap: false,
    });
    expect(metrics.tokenEquivalent).toBeNull();
    expect(metrics.sameAssetWrap).toBe(false);
  });
});
