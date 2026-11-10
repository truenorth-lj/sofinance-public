import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { StockPerformance } from "@/lib/position-performance-report";
import { StockPerformanceTiles } from "./stock-performance-tiles";

const stock: StockPerformance = {
  symbol: "SNDK", priceMint: "plain", priceUsd: 900, change24hPct: -2,
  sharesNow: 0.401697, valueUsd: 355.3745, sharesIn: null, firstDepositAtIso: null,
  entryPriceUsd: null, priceChangeUsd: null, priceChangePct: null,
  feeShares: 0.0189176, feeUsd: 16.7067, totalUsd: null,
  sparkline24h: [], sparklineSinceEntry: [], entryPriceSource: null,
  entryUnavailableReason: "Entry price was not recorded for this position.",
};
it("shows existing value and fees with explicit unknown entry and total, without fabricated charts or attribution", () => {
  const html = renderToStaticMarkup(<StockPerformanceTiles stock={stock} />);
  expect(html).toContain("$355.37");
  expect(html).toContain("$16.71");
  expect(html).toContain("Entry price was not recorded");
  expect(html).toContain('data-testid="stock-total"');
  expect(html).toContain("Total since deposit");
  expect(html.split('data-testid="stock-tile-shares"')[1]?.split('data-testid="stock-tile-fees"')[0]).toContain(">—<");
  expect(html.split('data-testid="stock-total"')[1]?.split('data-testid="stock-footnote"')[0]).toContain(">—<");
  expect(html).toContain("Collected plus unclaimed fees");
  expect(html).not.toContain("CoinGecko");
  expect(html).not.toContain("daily close");
  expect(html).not.toContain("<polyline");
});
