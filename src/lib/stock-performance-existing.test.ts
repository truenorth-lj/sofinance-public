import { expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { buildStockPerformance } from "./stock-performance-build";
import { computeStockPerformance } from "./stock-performance";
import type { TokenNativeMetrics } from "@sofinance/engine/position-performance-math";
import type { PairGuard } from "@sofinance/engine/valuation/pair-pricing";

/** The report's registry pricing (per raw unit, multiplier applied); multipliers default to 1. */
const pricing = ({ a, b, multiplierA = 1, multiplierB = 1, guard = null }: { a: number | null; b: number | null;
  multiplierA?: number | null; multiplierB?: number | null; guard?: PairGuard | null }) =>
  ({ usdPerRawUnitA: a, usdPerRawUnitB: b, multiplierA, multiplierB, guard });

it("reuses report amounts and USD valuations without making historical-price requests", async () => {
  const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error("No extra network calls allowed"));
  const stock = await buildStockPerformance({
    history: [], positionId: "position", poolId: "pool", mintA: "plain", mintB: "wrapped",
    decimalsA: 6, decimalsB: 6, incomplete: false, nowSeconds: 1_800_000_000,
    tokenNative: { tokenEquivalent: { baseSymbol: "SNDK", baseSide: "A", uiPriceBPerA: 2,
      metrics: { equity: 0.401697, feesEarned: 0.0189176 } } } as TokenNativeMetrics,
    quotes: new Map([
      ["plain", { source: "jupiter" as const, basis: "per-share" as const, price: 900, priceChange24hPct: 2, liquidityUsd: 10 }],
      ["wrapped", { source: "jupiter" as const, basis: "per-share" as const, price: 450, priceChange24hPct: -3, liquidityUsd: 1000 }],
    ]),
    pricing: pricing({ a: 900, b: 450 }),
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
    quote: { mint: "plain", priceChange24hPct: 2 }, basePricing: { usdPerRawUnit: 900, multiplier: 1 },
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
    ["plain", { source: "jupiter" as const, basis: "per-share" as const, price: 900, priceChange24hPct: 2, liquidityUsd: 1000 }],
    ["wrapped", { source: "jupiter" as const, basis: "per-share" as const, price: 450, priceChange24hPct: -3, liquidityUsd: 10 }],
  ]);
  if (onlyOtherQuote) quotes.delete("plain");
  const stock = await buildStockPerformance({
    history: [], positionId: "position", poolId: "pool", mintA: "plain", mintB: "wrapped",
    decimalsA: 6, decimalsB: 6, incomplete: false, nowSeconds: 1_800_000_000,
    tokenNative: { tokenEquivalent: { baseSymbol: "SNDK", baseSide, uiPriceBPerA: 2,
      metrics: { equity: 0.401697, feesEarned: 0.0189176 } } } as TokenNativeMetrics,
    metrics: { currentEquityUsd: valueUsd, feesEarnedUsd: feeUsd }, quotes, fetcher,
    pricing: pricing({ a: onlyOtherQuote ? null : 900, b: 450 }),
  });
  expect(stock?.priceMint).toBe(expectedMint);
  expect(stock?.priceUsd).toBe(expectedMint === null ? null : quotes.get(expectedMint)!.price);
  expect(stock?.valueUsd).toBe(valueUsd);
  expect(stock?.feeUsd).toBe(feeUsd);
  expect(stock?.priceChangeUsd).toBeNull();
  expect(stock?.totalUsd).toBeNull();
  expect(fetcher).not.toHaveBeenCalled();
});

const sndkInput = (overrides: Partial<Parameters<typeof buildStockPerformance>[0]> = {}): Parameters<typeof buildStockPerformance>[0] => ({
  history: [], positionId: "position", poolId: "pool", mintA: "sndk", mintB: "sndkx", decimalsA: 8, decimalsB: 8,
  incomplete: false, nowSeconds: 1_800_000_000,
  tokenNative: { tokenEquivalent: { baseSymbol: "SNDK", baseSide: "A", uiPriceBPerA: 1, metrics: { equity: 2.5, feesEarned: 0.02 } } } as TokenNativeMetrics,
  quotes: new Map([["sndk", { source: "jupiter" as const, basis: "per-share" as const, price: 78.63, priceChange24hPct: 1, liquidityUsd: 10 }]]),
  metrics: { currentEquityUsd: 1572.6, feesEarnedUsd: 12.58 },
  pricing: pricing({ a: 78.63 * 8, b: 80.99 * 8, multiplierA: 8, multiplierB: 8 }),
  fetcher: vi.fn<typeof fetch>(),
  ...overrides,
});

it("shows the base side's share price from the registry, not the raw quote number (X3-6)", async () => {
  const stock = await buildStockPerformance(sndkInput());
  expect(stock?.priceUsd).toBeCloseTo(78.63, 9);
  expect(stock?.sharesNow).toBeCloseTo(20, 9);
  expect(stock?.feeShares).toBeCloseTo(0.16, 9);
});

it("a per-raw fallback quote is divided by the multiplier, never shown as a share price (X3-6)", async () => {
  // DexScreener prices a raw SNDK unit (~$630.67, design §0); the registry never multiplies it again.
  const stock = await buildStockPerformance(sndkInput({
    quotes: new Map([["sndk", { source: "dexscreener" as const, basis: "per-raw-unit" as const, price: 630.67 }]]),
    pricing: pricing({ a: 630.67, b: 640, multiplierA: 8, multiplierB: 8 }),
  }));
  expect(stock?.priceUsd).toBeCloseTo(630.67 / 8, 9);
});

it("uses the base side's own price when the pair guard corrected it (single-asset display, X3-6)", async () => {
  const stock = await buildStockPerformance(sndkInput({
    pricing: pricing({ a: 80.99 * 8, b: 80.99 * 8, multiplierA: 8, multiplierB: 8,
      guard: { kind: "corrected", relativeDiff: 0.03, side: "a", rule: "liquidity", ownUsdPerRawUnit: 78.63 * 8 } }),
  }));
  expect(stock?.priceUsd).toBeCloseTo(78.63, 9);
});

it("has no stock view when the base multiplier is unknown (never treated as 1)", async () => {
  for (const multiplierA of [null, 0, Number.NaN]) {
    const stock = await buildStockPerformance(sndkInput({ pricing: pricing({ a: null, b: 640, multiplierA, multiplierB: 8 }) }));
    expect(stock).toBeNull();
  }
});
