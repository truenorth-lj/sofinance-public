// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StockCardsView } from "./stock-cards";
import type { HomepageStocks } from "@/lib/stock-market/public";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const stocks: HomepageStocks = {
  snapshotAt: "2026-11-04T12:02:00.000Z",
  gainers: [
    { underlying: "TSLA", company: "Tesla", priceUsd: 250.5, change24hPct: 4.2, icon: null },
    { underlying: "AMZN", company: "Amazon", priceUsd: 101, change24hPct: 1.1, icon: null },
  ],
  stocks: [{ underlying: "TSLA", company: "Tesla", priceUsd: 250.5, change24hPct: 4.2, icon: null, mcapUsd: 12_300_000 }],
  buy: {
    TSLA: { underlying: "TSLA", company: "Tesla", mint: "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB", mintShort: "XsDo…oB", issuerName: "xStocks", symbol: "TSLAx" },
    AMZN: { underlying: "AMZN", company: "Amazon", mint: "Xs3eBt7uRfJX8QUs4suhyU8p2M6DoUDrJyWBa8LLZsg", mintShort: "Xs3e…Zsg", issuerName: "xStocks", symbol: "AMZNx" },
  },
} as unknown as HomepageStocks;

let host: HTMLDivElement; let root: Root;
beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });

describe("StockCardsView", () => {
  it("shows the rows it is given; there is no Buy button, the whole row opens Buy", () => {
    const onBuy = vi.fn();
    act(() => root.render(<StockCardsView stocks={stocks} onBuy={onBuy} />));
    const gainers = host.querySelector('[data-testid="stock-card-gainers"]')!;
    expect(gainers.textContent).toContain("Top Gainers");
    expect(host.querySelector('[data-testid="stock-card-stocks"]')!.textContent).toContain("Top Stocks");
    expect([...gainers.querySelectorAll('[data-testid^="stock-row-"]')].map((row) => row.getAttribute("data-testid"))).toEqual(["stock-row-TSLA", "stock-row-AMZN"]);
    // The row's only control is the row itself: one button spanning the row, with no visible "Buy" label.
    const tsla = gainers.querySelector('[data-testid="stock-row-TSLA"]')!;
    const rowButton = tsla.querySelector<HTMLButtonElement>('button[data-testid="stock-buy-TSLA"]')!;
    expect(tsla.querySelectorAll("button")).toHaveLength(1);
    expect(rowButton.textContent).toContain("Tesla");
    expect(rowButton.textContent).toContain("$250.50");
    expect([...host.querySelectorAll("button")].some((button) => button.textContent?.trim() === "Buy")).toBe(false);
    expect(rowButton.querySelector(".sr-only")!.textContent).toBe(": buy Tesla with USDC");
    // No greyed "Not supported yet" anywhere: unsupported stocks are not listed at all (the server leaves them out).
    expect(host.textContent).not.toContain("Not supported yet");
    expect(host.querySelector("button[disabled]")).toBeNull();
    act(() => (gainers.querySelector('[data-testid="stock-buy-TSLA"]') as HTMLButtonElement).click());
    expect(onBuy).toHaveBeenCalledWith(stocks.buy.TSLA);
  });

  it("shows the rows without any button when the eligibility read failed", () => {
    act(() => root.render(<StockCardsView stocks={{ ...stocks, buy: {} }} onBuy={() => undefined} />));
    expect(host.querySelectorAll('[data-testid^="stock-row-"]')).toHaveLength(3);
    expect(host.querySelector('[data-testid^="stock-buy-"]')).toBeNull();
    expect(host.querySelector("button")).toBeNull();
  });

  it("shows the third-party notice and the UTC snapshot time", () => {
    act(() => root.render(<StockCardsView stocks={stocks} onBuy={() => undefined} />));
    const notice = host.querySelector('[data-testid="stock-cards-notice"]')!.textContent!;
    expect(notice).toContain("Not available to US persons or restricted regions. Tokens are issued by third parties.");
    expect(notice).toContain("2026-11-04 12:02 UTC");
  });

  it("keeps the notice and shows a loading state without data", () => {
    act(() => root.render(<StockCardsView stocks={null} onBuy={() => undefined} />));
    expect(host.querySelector('[role="status"]')!.textContent).toContain("Loading");
    expect(host.querySelector('[data-testid^="stock-buy-"]')).toBeNull();
    expect(host.querySelector('[data-testid="stock-cards-notice"]')!.textContent).toContain("Tokens are issued by third parties.");
  });
});
