import { expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { buildStockPerformance } from "./stock-performance-build";
import { computeStockPerformance } from "./stock-performance";
import type { TokenNativeMetrics } from "@sofinance/engine/position-performance-math";

it("reuses report amounts and USD valuations without making historical-price requests", async () => {
  const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error("No extra network calls allowed"));
  const stock = await buildStockPerformance({
    history: [], positionId: "position", poolId: "pool", mintA: "plain", mintB: "wrapped",
    decimalsA: 6, decimalsB: 6, incomplete: false, nowSeconds: 1_800_000_000,
    tokenNative: { tokenEquivalent: { baseSymbol: "SNDK", baseSide: "A", uiPriceBPerA: 2,
      metrics: { equity: 0.401697, feesEarned: 0.0189176 } } } as TokenNativeMetrics,
    quotes: new Map([
      ["plain", { source: "jupiter" as const, price: 900, priceChange24hPct: 2, liquidityUsd: 10 }],
      ["wrapped", { source: "jupiter" as const, price: 450, priceChange24hPct: -3, liquidityUsd: 1000 }],
    ]),
    fetcher,
    metrics: { currentEquityUsd: 355.3745, feesEarnedUsd: 16.7067 },
  });
  expect(stock?.valueUsd).toBe(355.3745);
  expect(stock?.feeUsd).toBe(16.7067);
  expect(fetcher).not.toHaveBeenCalled();
  expect(stock?.priceMint).toBe("plain");
  expect(stock?.priceUsd).toBe(900);
  expect(stock?.sharesNow).toBe(0.401697);
  expect(stock?.feeShares).toBe(0.0189176);
  expect(stock?.entryPriceUsd).toBeNull();
  expect(stock?.priceChangeUsd).toBeNull();
  expect(stock?.totalUsd).toBeNull();
  expect(stock?.sparkline24h).toEqual([]);
  expect(stock?.sparklineSinceEntry).toEqual([]);
});

it("does not turn daily closes or reinvestments into recorded entry prices", () => {
  const stock = computeStockPerformance({
    history: [{ blockTime: 1_800_000_000, events: [{ kind: "open", poolState: "pool", nftOwner: "wallet",
      tickLower: -1, tickUpper: 1, liquidity: "1", amountA: "1", amountB: "0" }] }],
    positionId: "position", poolId: "pool", decimalsA: 0, decimalsB: 0, incomplete: false,
    tokenEquivalent: { baseSymbol: "SNDK", baseSide: "A", uiPriceBPerA: 1, metrics: { equity: 1, feesEarned: 0 } },
    quote: { mint: "plain", usdPrice: 900, priceChange24hPct: 2 },
    daily: [{ time: 1_799_971_200, close: 800 }], hourly: [], historySource: "cached historical prices", nowSeconds: 1_800_000_001,
  });
  expect(stock.entryPriceUsd).toBeNull();
  expect(stock.priceChangeUsd).toBeNull();
  expect(stock.sharesIn).toBeNull();
  expect(stock.totalUsd).toBeNull();
  expect(stock.sparklineSinceEntry).toEqual([]);
});

it.each([
  { name: "base side B", baseSide: "B" as const, onlyOtherQuote: false, unknownUsd: false, expectedMint: "wrapped" },
  { name: "only the other side has a quote", baseSide: "A" as const, onlyOtherQuote: true, unknownUsd: false, expectedMint: null },
  { name: "USD valuation is unknown", baseSide: "A" as const, onlyOtherQuote: false, unknownUsd: true, expectedMint: "plain" },
])("preserves units and missing values when $name", async ({ baseSide, onlyOtherQuote, unknownUsd, expectedMint }) => {
  const fetcher = vi.fn<typeof fetch>();
  const valueUsd = unknownUsd ? null : 355.3745;
  const feeUsd = unknownUsd ? null : 16.7067;
  const quotes = new Map([
    ["plain", { source: "jupiter" as const, price: 900, priceChange24hPct: 2, liquidityUsd: 1000 }],
    ["wrapped", { source: "jupiter" as const, price: 450, priceChange24hPct: -3, liquidityUsd: 10 }],
  ]);
  if (onlyOtherQuote) quotes.delete("plain");
  const stock = await buildStockPerformance({
    history: [], positionId: "position", poolId: "pool", mintA: "plain", mintB: "wrapped",
    decimalsA: 6, decimalsB: 6, incomplete: false, nowSeconds: 1_800_000_000,
    tokenNative: { tokenEquivalent: { baseSymbol: "SNDK", baseSide, uiPriceBPerA: 2,
      metrics: { equity: 0.401697, feesEarned: 0.0189176 } } } as TokenNativeMetrics,
    metrics: { currentEquityUsd: valueUsd, feesEarnedUsd: feeUsd }, quotes, fetcher,
  });
  expect(stock?.priceMint).toBe(expectedMint);
  expect(stock?.priceUsd).toBe(expectedMint === null ? null : quotes.get(expectedMint)!.price);
  expect(stock?.valueUsd).toBe(valueUsd);
  expect(stock?.feeUsd).toBe(feeUsd);
  expect(stock?.priceChangeUsd).toBeNull();
  expect(stock?.totalUsd).toBeNull();
  expect(fetcher).not.toHaveBeenCalled();
});
