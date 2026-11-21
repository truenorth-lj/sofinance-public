import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@sofinance/engine/token-prices", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@sofinance/engine/token-prices")>()),
  fetchTokenPricesUsd: vi.fn(),
}));

const { fetchTokenPricesUsd } = await import("@sofinance/engine/token-prices");
const { describePositionPricing, priceAndLabel } = await import("./position-performance-assemble");

const MINT_A = "mintA-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const MINT_B = "mintB-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const POOL = "pool-cccccccccccccccccccccccccccccccc";
const QUOTE_A = { price: 12.5, source: "jupiter" as const, basis: "per-share" as const };

describe("priceAndLabel", () => {
  it("keeps a Jupiter mintA quote when the Raydium fallback throws for mintB", async () => {
    vi.mocked(fetchTokenPricesUsd).mockResolvedValue(new Map([[MINT_A, QUOTE_A]]));
    const fetcher = vi.fn(async () => { throw new Error("raydium unavailable"); });

    const result = await priceAndLabel({
      mintA: MINT_A, mintB: MINT_B, fetcher, jupiterApiKey: "test-key", raydiumPoolId: POOL,
    });
    const described = describePositionPricing(QUOTE_A, undefined);

    expect(fetcher).toHaveBeenCalled();
    expect(result.priceUsdA).toBe(12.5);
    expect(result.priceUsdB).toBeNull();
    expect(result.pricingSource).toBe(described.source);
    expect(result.pricingLabel).toBe(described.label);
    expect(result.pricingLabel).not.toBe("USD pricing request failed; USD metrics null.");
  });

  it("labels the Raydium pool fallback per raw unit without changing its USD values", async () => {
    const usdc = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
    vi.mocked(fetchTokenPricesUsd).mockResolvedValue(new Map());
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ data: [{ price: 630.67 }] }), { status: 200 }));
    const result = await priceAndLabel({ mintA: MINT_A, mintB: usdc, fetcher, jupiterApiKey: "test-key", raydiumPoolId: POOL });
    const described = describePositionPricing(
      { price: 630.67, source: "raydium", basis: "per-raw-unit" },
      { price: 1, source: "raydium", basis: "per-raw-unit" },
    );
    expect(result).toMatchObject({ priceUsdA: 630.67, priceUsdB: 1, pricingSource: described.source, pricingLabel: described.label });
  });
});
