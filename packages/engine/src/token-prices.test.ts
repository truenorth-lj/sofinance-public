import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetJupiterRuntime } from "./jupiter";
import {
  DEXSCREENER_SOLANA_TOKENS_URL,
  fetchJupiterPricesUsd,
  pickDexScreenerUsdPrice,
  resetTokenPriceRuntime,
} from "./token-prices";

const TSLAX = "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const UNKNOWN = "UnkMint111111111111111111111111111111111111";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function pair(input: {
  mint?: string;
  side?: "base" | "quote";
  priceUsd: number | string;
  priceNative?: number | string;
  liquidityUsd?: number;
  quote?: string;
}) {
  const mint = input.mint ?? TSLAX;
  const side = input.side ?? "base";
  return {
    chainId: "solana",
    dexId: "raydium",
    baseToken: { address: side === "base" ? mint : input.quote ?? USDC, symbol: side === "base" ? "TSLAx" : "USDC" },
    quoteToken: { address: side === "quote" ? mint : input.quote ?? USDC, symbol: side === "quote" ? "TSLAx" : "USDC" },
    priceUsd: input.priceUsd,
    priceNative: input.priceNative ?? "1",
    liquidity: { usd: input.liquidityUsd ?? 1_000 },
  };
}

function mockFetch(handler: (url: string) => Response | Promise<Response>) {
  return vi.fn(async (input: RequestInfo | URL) => handler(String(input)));
}

beforeEach(() => {
  vi.stubEnv("JUPITER_API_KEY", "");
  resetJupiterRuntime();
  resetTokenPriceRuntime({ jupiterSpacingMs: 0, dexScreenerSpacingMs: 0 });
});

describe("pickDexScreenerUsdPrice", () => {
  it("picks the highest-liquidity pair where the mint is the base token", () => {
    const payload = [
      pair({ priceUsd: "100", liquidityUsd: 10 }),
      pair({ priceUsd: "377.36", liquidityUsd: 2_255_035 }),
      pair({ priceUsd: "50", liquidityUsd: 5 }),
    ];
    expect(pickDexScreenerUsdPrice(payload, TSLAX)).toBe(377.36);
  });

  it("derives a quote-token price as priceUsd / priceNative", () => {
    expect(pickDexScreenerUsdPrice([
      pair({ side: "quote", priceUsd: "377.36", priceNative: "0.0026503", liquidityUsd: 9_000 }),
    ], TSLAX)).toBeCloseTo(377.36 / 0.0026503, 6);
  });

  it("returns null when no pair yields a price", () => {
    expect(pickDexScreenerUsdPrice([], TSLAX)).toBeNull();
    expect(pickDexScreenerUsdPrice([pair({ mint: USDC, priceUsd: "1" })], TSLAX)).toBeNull();
    expect(pickDexScreenerUsdPrice("nope", TSLAX)).toBeNull();
  });
});

describe("fetchJupiterPricesUsd", () => {
  it("uses Jupiter Price API v3 when the mint is present", async () => {
    const fetcher = mockFetch((url) => {
      if (url.includes("/price/v3")) return json(200, { [TSLAX]: { usdPrice: 376.79702919622997, decimals: 8 } });
      throw new Error(`unexpected fetch ${url}`);
    });
    const prices = await fetchJupiterPricesUsd([TSLAX], fetcher);
    expect(prices.get(TSLAX)).toBe(376.79702919622997);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0]?.[0])).toContain("/price/v3");
    expect(String(fetcher.mock.calls[0]?.[0])).toContain(TSLAX);
  });

  it("falls back to DexScreener when Jupiter returns 429", async () => {
    const fetcher = mockFetch((url) => {
      if (url.includes("/price/v3")) return json(429, { error: "rate limited" });
      if (url.startsWith(DEXSCREENER_SOLANA_TOKENS_URL)) return json(200, [pair({ priceUsd: "377.36", liquidityUsd: 2_255_035 })]);
      throw new Error(`unexpected fetch ${url}`);
    });
    const prices = await fetchJupiterPricesUsd([TSLAX], fetcher);
    expect(prices.get(TSLAX)).toBe(377.36);
    expect(fetcher.mock.calls.map(([input]) => String(input))).toEqual([
      expect.stringContaining("/price/v3"),
      `${DEXSCREENER_SOLANA_TOKENS_URL}/${TSLAX}`,
    ]);
  });

  it("falls back to DexScreener for a mint Jupiter omits", async () => {
    const fetcher = mockFetch((url) => {
      if (url.includes("/price/v3")) return json(200, { [USDC]: { usdPrice: 0.9998 } });
      if (url.startsWith(DEXSCREENER_SOLANA_TOKENS_URL)) {
        expect(url).toBe(`${DEXSCREENER_SOLANA_TOKENS_URL}/${TSLAX}`);
        return json(200, [pair({ priceUsd: "377.36" })]);
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    const prices = await fetchJupiterPricesUsd([USDC, TSLAX], fetcher);
    expect(prices.get(USDC)).toBe(0.9998);
    expect(prices.get(TSLAX)).toBe(377.36);
  });

  it("returns an empty map and does not throw when both sources omit the mint", async () => {
    const fetcher = mockFetch((url) => {
      if (url.includes("/price/v3")) return json(200, {});
      if (url.startsWith(DEXSCREENER_SOLANA_TOKENS_URL)) return json(200, []);
      throw new Error(`unexpected fetch ${url}`);
    });
    await expect(fetchJupiterPricesUsd([UNKNOWN], fetcher)).resolves.toEqual(new Map());
  });

  it("sends x-api-key only when a server JUPITER_API_KEY / apiKey is provided", async () => {
    const fetcher = mockFetch((url) => {
      if (url.includes("/price/v3")) return json(200, { [TSLAX]: { usdPrice: 376.8 } });
      throw new Error(`unexpected fetch ${url}`);
    });
    await fetchJupiterPricesUsd([TSLAX], fetcher);
    const keylessHeaders = (fetcher.mock.calls[0]?.[1] as RequestInit | undefined)?.headers as Record<string, string>;
    expect(keylessHeaders["x-api-key"]).toBeUndefined();
    expect(Object.keys(keylessHeaders).some((name) => name.toLowerCase().includes("next_public"))).toBe(false);

    resetJupiterRuntime();
    resetTokenPriceRuntime({ jupiterSpacingMs: 0, dexScreenerSpacingMs: 0 });
    await fetchJupiterPricesUsd([TSLAX], fetcher, "unit-test-jupiter-key");
    const keyedHeaders = (fetcher.mock.calls[1]?.[1] as RequestInit | undefined)?.headers as Record<string, string>;
    expect(keyedHeaders["x-api-key"]).toBe("unit-test-jupiter-key");
  });

  it("shares one in-flight Jupiter request across concurrent callers", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const fetcher = mockFetch(async (url) => {
      if (url.includes("/price/v3")) {
        await gate;
        return json(200, { [TSLAX]: { usdPrice: 376.8 } });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    const first = fetchJupiterPricesUsd([TSLAX], fetcher);
    const second = fetchJupiterPricesUsd([TSLAX], fetcher);
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(a.get(TSLAX)).toBe(376.8);
    expect(b.get(TSLAX)).toBe(376.8);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
