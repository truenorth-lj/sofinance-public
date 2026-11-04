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
    { underlying: "NFLX", company: "Netflix", priceUsd: 101, change24hPct: 1.1, icon: null },
  ],
  stocks: [{ underlying: "TSLA", company: "Tesla", priceUsd: 250.5, change24hPct: 4.2, icon: null, mcapUsd: 12_300_000 }],
  buy: { TSLA: { underlying: "TSLA", company: "Tesla", mint: "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB", mintShort: "XsDo…oB", issuerName: "xStocks", symbol: "TSLAx" } },
} as unknown as HomepageStocks;

let host: HTMLDivElement; let root: Root;
beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });

describe("StockCardsView", () => {
  it("shows a Buy button only for stocks the server selected an issuer for", () => {
    const onBuy = vi.fn();
    act(() => root.render(<StockCardsView stocks={stocks} onBuy={onBuy} />));
    const gainers = host.querySelector('[data-testid="stock-card-gainers"]')!;
    expect(gainers.textContent).toContain("Top Gainers");
    expect(host.querySelector('[data-testid="stock-card-stocks"]')!.textContent).toContain("Top Stocks");
    expect(gainers.querySelector('[data-testid="stock-buy-TSLA"]')).not.toBeNull();
    expect(gainers.querySelector('[data-testid="stock-row-NFLX"]')).not.toBeNull();
    expect(gainers.querySelector('[data-testid="stock-buy-NFLX"]')).toBeNull();
    act(() => (gainers.querySelector('[data-testid="stock-buy-TSLA"]') as HTMLButtonElement).click());
    expect(onBuy).toHaveBeenCalledWith(stocks.buy.TSLA);
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
