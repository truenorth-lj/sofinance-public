// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PositionPerformanceReport, StockPerformance } from "@/lib/position-performance-report";
import { StockPerformanceTiles } from "./stock-performance-tiles";
import { StocksOverview, type OverviewPosition } from "./stocks-overview";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const nvda: StockPerformance = {
  symbol: "NVDA", priceMint: "NVDAx", priceUsd: 176.35, change24hPct: -6.08, sharesNow: 2.5312, valueUsd: 446.38, sharesIn: 2.5,
  firstDepositAtIso: "2026-10-20T01:00:00.000Z", entryPriceUsd: 187.2, priceChangeUsd: -27.125, priceChangePct: -5.796,
  feeShares: 0.0312, feeUsd: 5.502, totalUsd: -21.623, sparkline24h: [180, 178, 176.35], sparklineSinceEntry: [187.2, 190, 176.35],
  entryPriceSource: "GeckoTerminal daily close, NVDAx / USDC pool", entryUnavailableReason: null,
};
const tsla: StockPerformance = { ...nvda, symbol: "TSLA", priceUsd: 412.1, change24hPct: 1.24, sharesIn: 1.2, sharesNow: 1.2075, valueUsd: 497.61,
  entryPriceUsd: 396.79, priceChangeUsd: 18.37, priceChangePct: 3.86, feeShares: 0.0075, feeUsd: 3.09, totalUsd: 21.46 };
const report = (stock: StockPerformance | null) => ({ stock } as unknown as PositionPerformanceReport);

let container: HTMLDivElement;
let root: Root;
beforeEach(() => { container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(() => { act(() => root.unmount()); container.remove(); });
const text = (testId: string) => container.querySelector(`[data-testid="${testId}"]`)?.textContent ?? "";

describe("StockPerformanceTiles", () => {
  it("shows the stock's 24h move, the shares put in since the deposit day, and the fees as shares and USD", () => {
    act(() => root.render(createElement(StockPerformanceTiles, { stock: nvda, pairLabel: "NVDA / NVDAx" })));
    expect(text("stock-tile-price")).toContain("NVDA price");
    expect(text("stock-tile-price")).toContain("$176.35");
    expect(text("stock-tile-price")).toContain("↓ 6.08%");
    expect(text("stock-tile-shares")).toContain("2.5 shares since Oct 20");
    expect(text("stock-tile-shares")).toContain("−$27.13");
    expect(text("stock-tile-shares")).toContain("from $187.20");
    expect(text("stock-tile-fees")).toContain("$5.50");
    expect(text("stock-tile-fees")).toContain("↑ 0.0312 NVDA");
    expect(text("stock-tile-fees")).not.toContain("at $");
    expect(text("stock-total")).toContain("−$21.62");
    expect(container.querySelectorAll('[data-testid="stock-sparkline"]')).toHaveLength(2);
    const credit = container.querySelector('[data-testid="stock-footnote"] a')!;
    expect(container.querySelector('[data-testid="stock-footnote"]')!.textContent).toContain("Powered by CoinGecko.");
    expect(credit.textContent).toBe("CoinGecko");
    expect(credit.getAttribute("href")).toBe("https://www.coingecko.com/en/api");
  });

  it("keeps every tile label on one line", () => {
    act(() => root.render(createElement(StockPerformanceTiles, { stock: nvda })));
    for (const tile of container.querySelectorAll('[data-testid^="stock-tile-"]')) {
      expect(tile.firstElementChild!.className).toContain("whitespace-nowrap");
      expect(tile.firstElementChild!.className).toContain("truncate");
    }
  });

  it("says why the price change is missing instead of showing zero", () => {
    act(() => root.render(createElement(StockPerformanceTiles, { stock: { ...nvda, entryPriceUsd: null, priceChangeUsd: null, priceChangePct: null,
      totalUsd: null, entryUnavailableReason: "Past prices for this stock are unavailable right now." } })));
    expect(text("stock-tile-shares")).toContain("—");
    expect(text("stock-tile-shares")).toContain("Past prices for this stock are unavailable right now.");
    expect(container.querySelector('[data-testid="stock-total"]')).toBeNull();
  });
});

describe("StocksOverview", () => {
  it("adds up every stock once all positions are read, one row per stock", async () => {
    let releaseSecond!: () => void;
    const positions: OverviewPosition[] = [
      { key: "p1", load: async () => report(nvda) },
      { key: "p2", load: () => new Promise((resolve) => { releaseSecond = () => resolve(report(tsla)); }) },
      { key: "p3", load: async () => report(null) },
    ];
    await act(async () => root.render(createElement(StocksOverview, { positions })));
    expect(container.textContent).toContain("Loading 1 of 3 positions");
    expect(text("overview-tile-fees")).toContain("—");
    expect(container.querySelectorAll('[data-testid="stock-row"]')).toHaveLength(1);

    await act(async () => releaseSecond());
    expect(container.querySelectorAll('[data-testid="stock-row"]')).toHaveLength(2);
    expect(text("overview-tile-fees")).toContain("$8.59");
    expect(text("overview-tile-fees")).toContain("across 2 stocks");
    expect(text("overview-tile-price")).toContain("−$8.75");
    expect(text("stocks-overview")).toContain("$943.99");

    const button = container.querySelector('[data-testid="stock-row"] button') as HTMLButtonElement;
    expect(button.getAttribute("aria-expanded")).toBe("false");
    await act(async () => button.click());
    expect(button.getAttribute("aria-expanded")).toBe("true");
  });

  it("shows nothing for a single position", async () => {
    await act(async () => root.render(createElement(StocksOverview, { positions: [{ key: "solo", load: async () => report(nvda) }] })));
    expect(container.querySelector('[data-testid="stocks-overview"]')).toBeNull();
  });
});
