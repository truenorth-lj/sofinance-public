import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { PositionPerformanceReport, StockPerformance } from "@/lib/position-performance-report";
import { PerformanceSummary } from "./position-performance-summary";
const stock: StockPerformance = {
  symbol: "NVDA", priceMint: "mint-a", priceUsd: 176.35, change24hPct: -6.08,
  sharesNow: 2.5312, valueUsd: 446.38, sharesIn: null, firstDepositAtIso: null,
  entryPriceUsd: null, priceChangeUsd: null, priceChangePct: null, feeShares: 0.0312, feeUsd: 5.50,
  totalUsd: null, sparkline24h: [], sparklineSinceEntry: [], entryPriceSource: null, entryUnavailableReason: "Entry price unavailable.",
};
const report: PositionPerformanceReport = {
  positionMint: "position", poolId: "pool", mintA: "mint-a", mintB: "mint-b", decimalsA: 6, decimalsB: 6,
  tickCurrent: 0, rangeSide: "inside", liquidity: "1", openedAtIso: null, evaluatedAtIso: "2026-11-10T00:00:00Z",
  truncated: false, signatureCount: 1, ownsNft: true, cashflows: { openCount: 1, increaseCount: 0, decreaseCount: 0 },
  stock, metrics: { holdingDays: 2, depositedUsd: null, currentEquityUsd: 446.38, liquidityUsd: 440,
    uncollectedFeesUsd: 6.38, feesEarnedUsd: 5.50, pnlUsd: null, holdingPeriodReturnPct: null,
    annualizedReturnPct: null, feeOnlyAprPct: 4, depositedRaw: { a: "1", b: "0" }, currentEquityRaw: { a: "1", b: "0" },
    liquidityAmountsRaw: { a: "1", b: "0" }, feesEarnedRaw: { a: "1", b: "0" }, uncollectedFeesRaw: { a: "1", b: "0" }, feesCollectedRaw: { a: "0", b: "0" } },
  tokenNative: { symbolA: "NVDA", symbolB: "NVDAx", sameAssetWrap: true, wrapKind: "fixture",
    amounts: { deposited: { a: 2, b: 0 }, currentEquity: { a: 2.5312, b: 0 }, feesEarned: { a: 0.0312, b: 0 },
      liquidityAmounts: { a: 2.5, b: 0 }, uncollectedFees: { a: 0.0312, b: 0 }, feesCollected: { a: 0, b: 0 },
      withdrawnPrincipal: { a: 0, b: 0 }, pnl: { a: 0, b: 0 } },
    perSideFeeAprPct: { a: 4, b: null }, tokenEquivalent: { baseSymbol: "NVDA", baseSide: "A", wrappedSymbol: "NVDAx", tickUsed: 0,
      uiPriceBPerA: 1, basis: "fixture", note: "fixture", metrics: { deposited: 2, equity: 2.5312, liquidity: 2.5,
        uncollectedFees: 0.0312, feesEarned: 0.0312, withdrawnPrincipal: 0, pnl: 0, holdingPeriodReturnPct: null, annualizedReturnPct: null, feeOnlyAprPct: 4 } } },
  pricing: { source: "fixture", label: "Test fixture, not live data", priceUsdA: 176.35, priceUsdB: 176.35 },
  assumptions: "fixture", method: "fixture",
};
it("omits stock summary cards already shown in the overview while keeping position details", () => {
  const html = renderToStaticMarkup(<PerformanceSummary data={report} embedded metadata={{}} showStockPerformance={false} />);
  expect(html).not.toContain('data-testid="stock-performance"');
  expect(html).not.toContain("Total since deposit");
  expect(html).toContain('data-testid="position-detail-identity"');
  expect(html).toContain("In range");
  expect(html).toContain("4.00%");
  expect(html).toContain("Time since the earliest recorded position event.");
});
it("keeps the standalone single-position stock summary by default", () => {
  const html = renderToStaticMarkup(<PerformanceSummary data={report} embedded metadata={{}} />);
  expect(html).toContain('data-testid="stock-performance"');
});
