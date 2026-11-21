import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@sofinance/engine/token-prices", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@sofinance/engine/token-prices")>()),
  fetchTokenPricesUsd: vi.fn(),
}));

const { fetchTokenPricesUsd } = await import("@sofinance/engine/token-prices");
const { describePositionPricing, priceAndLabel, pricePosition } = await import("./position-performance-assemble");

const MINT_A = "mintA-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const MINT_B = "mintB-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const POOL = "pool-cccccccccccccccccccccccccccccccc";
const QUOTE_A = { price: 12.5, source: "jupiter" as const, basis: "per-share" as const };
const PLAIN = { kind: "mint-extensions" as const, scaledUiConfig: null };
const NOW_MS = Date.parse("2026-11-21T08:00:00Z");
const sides = (mintB = MINT_B) => ({
  a: { mint: MINT_A, decimals: 6, hint: PLAIN }, b: { mint: mintB, decimals: 6, hint: PLAIN }, poolPriceBPerA: null, nowMs: NOW_MS,
});

describe("priceAndLabel", () => {
  it("keeps a Jupiter mintA quote when the Raydium fallback throws for mintB", async () => {
    vi.mocked(fetchTokenPricesUsd).mockResolvedValue(new Map([[MINT_A, QUOTE_A]]));
    const fetcher = vi.fn(async () => { throw new Error("raydium unavailable"); });

    const { pricing } = await priceAndLabel({ ...sides(), fetcher, jupiterApiKey: "test-key", raydiumPoolId: POOL });
    const described = describePositionPricing(QUOTE_A, undefined);

    expect(fetcher).toHaveBeenCalled();
    expect(pricing.usdPerRawUnitA).toBe(12.5);
    expect(pricing.usdPerRawUnitB).toBeNull();
    expect(pricing.source).toBe(described.source);
    expect(pricing.label).toBe(described.label);
    expect(pricing.label).not.toBe("USD pricing request failed; USD metrics null.");
    expect(pricing.guard).toEqual({ kind: "not-checked", reason: "no-multiplier" });
  });

  it("labels the Raydium pool fallback per raw unit without changing its USD values", async () => {
    const usdc = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
    vi.mocked(fetchTokenPricesUsd).mockResolvedValue(new Map());
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ data: [{ price: 630.67 }] }), { status: 200 }));
    const { pricing } = await priceAndLabel({ ...sides(usdc), fetcher, jupiterApiKey: "test-key", raydiumPoolId: POOL });
    const described = describePositionPricing(
      { price: 630.67, source: "raydium", basis: "per-raw-unit" },
      { price: 1, source: "raydium", basis: "per-raw-unit" },
    );
    expect(pricing).toMatchObject({ usdPerRawUnitA: 630.67, usdPerRawUnitB: 1, source: described.source, label: described.label,
      basis: { a: "per-raw-unit", b: "per-raw-unit" } });
  });

  it("an asset with no multiplier fact is not priced (never valued as 1)", async () => {
    vi.mocked(fetchTokenPricesUsd).mockResolvedValue(new Map([[MINT_A, QUOTE_A], [MINT_B, QUOTE_A]]));
    const { pricing } = await priceAndLabel({ ...sides(), a: { mint: MINT_A, decimals: 6, hint: null }, fetcher: vi.fn(), jupiterApiKey: "test-key" });
    expect(pricing).toMatchObject({ usdPerRawUnitA: null, multiplierA: null, usdPerRawUnitB: 12.5, guard: { kind: "not-checked", reason: "no-multiplier" } });
  });

  it("skipped pricing reads nothing and returns no prices", async () => {
    vi.mocked(fetchTokenPricesUsd).mockClear();
    const { pricing } = await priceAndLabel({ ...sides(), skipPricing: true, fetcher: vi.fn() });
    expect(fetchTokenPricesUsd).not.toHaveBeenCalled();
    expect(pricing).toMatchObject({ source: "none", usdPerRawUnitA: null, usdPerRawUnitB: null, guard: null });
  });
});

describe("pricePosition logs", () => {
  const SNDKX = "Xswbpc8UqU6e1j9QZEWCjBMjyvz4twqD7PCy6j2e7jj";
  it("logs a multiplier conflict (mint account vs Jupiter) and a pair-guard correction as one [valuation] line each", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const eight = { multiplier: 8, newMultiplier: 8, newMultiplierEffectiveTimestamp: 0 };
    const pricing = pricePosition({
      a: { mint: MINT_A, decimals: 6, hint: { kind: "mint-extensions", scaledUiConfig: eight } },
      b: { mint: SNDKX, decimals: 8, hint: { kind: "mint-extensions", scaledUiConfig: eight } },
      quoteA: { price: 78.63, source: "jupiter", basis: "per-share", liquidityUsd: 10_000 },
      quoteB: { price: 80.99, source: "jupiter", basis: "per-share", liquidityUsd: 90_000,
        scaledUiConfig: { multiplier: 1, newMultiplier: 1, newMultiplierEffectiveTimestamp: null } },
      poolPriceBPerA: 0.9996, nowMs: NOW_MS, quotesObservedAtMs: NOW_MS, logContext: { poolId: POOL },
    });
    expect(pricing.guard).toMatchObject({ kind: "corrected", side: "a", rule: "liquidity" });
    expect(pricing.usdPerRawUnitA).toBeCloseTo(0.9996 * 80.99 * 8, 9);
    const lines = warn.mock.calls.map(([tag, body]) => [tag, JSON.parse(body as string)]);
    expect(lines).toEqual([
      ["[valuation]", expect.objectContaining({ poolId: POOL, kind: "multiplier-conflict", asset: `solana:${SNDKX}`,
        chosen: { origin: "mint-account", observedAtMs: null, multiplier: 8 } })],
      ["[valuation]", expect.objectContaining({ poolId: POOL, kind: "pair-guard", guard: expect.objectContaining({ kind: "corrected" }) })],
    ]);
    warn.mockRestore();
  });
});
