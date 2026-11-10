import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetJupiterRuntime } from "./jupiter";
import {
  DEXSCREENER_MIN_LIQUIDITY_USD,
  DEXSCREENER_SOLANA_TOKENS_URL,
  fetchJupiterPricesUsd,
  fetchTokenPricesUsd,
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
  liquidityUsd?: number | null;
  quote?: string;
}) {
  const mint = input.mint ?? TSLAX;
  const side = input.side ?? "base";
  const liquidity = input.liquidityUsd === null
    ? undefined
    : { usd: input.liquidityUsd ?? 50_000 };
  return {
    chainId: "solana",
    dexId: "raydium",
    baseToken: { address: side === "base" ? mint : input.quote ?? USDC, symbol: side === "base" ? "TSLAx" : "USDC" },
    quoteToken: { address: side === "quote" ? mint : input.quote ?? USDC, symbol: side === "quote" ? "TSLAx" : "USDC" },
    priceUsd: input.priceUsd,
    priceNative: input.priceNative ?? "1",
    ...(liquidity ? { liquidity } : {}),
  };
}

function mockFetch(handler: (url: string) => Response | Promise<Response>) {
  return vi.fn(async (...args: [input: RequestInfo | URL, init?: RequestInit]) => handler(String(args[0])));
}

beforeEach(() => {
  vi.stubEnv("JUPITER_API_KEY", "");
  resetJupiterRuntime();
  resetTokenPriceRuntime({ jupiterSpacingMs: 0, dexScreenerSpacingMs: 0 });
});

describe("pickDexScreenerUsdPrice", () => {
  it("picks the highest-liquidity pair where the mint is the base token", () => {
    const payload = [
      pair({ priceUsd: "100", liquidityUsd: 12_000 }),
      pair({ priceUsd: "377.36", liquidityUsd: 2_255_035 }),
      pair({ priceUsd: "50", liquidityUsd: 11_000 }),
    ];
    expect(pickDexScreenerUsdPrice(payload, TSLAX)).toBe(377.36);
  });

  it("prefers a base-token pair over a higher-liquidity quote-token pair", () => {
    expect(pickDexScreenerUsdPrice([
      pair({ side: "base", priceUsd: "377.36", liquidityUsd: 20_000 }),
      pair({ side: "quote", priceUsd: 1, priceNative: 1 / 500, liquidityUsd: 5_000_000 }),
    ], TSLAX)).toBe(377.36);
  });

  it("derives a quote-token price as priceUsd / priceNative with realistic numbers", () => {
    // USDC as base (~$1), TSLAx as quote: priceNative is how many TSLAx one USDC buys.
    const tslaxUsd = 377.36;
    expect(pickDexScreenerUsdPrice([
      pair({ side: "quote", priceUsd: 1, priceNative: 1 / tslaxUsd, liquidityUsd: 50_000 }),
    ], TSLAX)).toBeCloseTo(tslaxUsd, 6);
  });

  it("rejects thin, missing, or zero-liquidity pairs and absurd quote-side math", () => {
    expect(pickDexScreenerUsdPrice([pair({ priceUsd: "377", liquidityUsd: DEXSCREENER_MIN_LIQUIDITY_USD - 1 })], TSLAX)).toBeNull();
    expect(pickDexScreenerUsdPrice([pair({ priceUsd: "377", liquidityUsd: 0 })], TSLAX)).toBeNull();
    expect(pickDexScreenerUsdPrice([pair({ priceUsd: "377", liquidityUsd: null })], TSLAX)).toBeNull();
    expect(pickDexScreenerUsdPrice([
      pair({ side: "quote", priceUsd: 1, priceNative: 1e-12, liquidityUsd: 50_000 }),
    ], TSLAX)).toBeNull();
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
    expect((await fetchTokenPricesUsd([TSLAX], fetcher)).get(TSLAX)).toEqual({ price: 376.79702919622997, source: "jupiter" });
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
    const quotes = await fetchTokenPricesUsd([TSLAX], fetcher);
    expect(quotes.get(TSLAX)).toEqual({ price: 377.36, source: "dexscreener" });
    expect(fetcher.mock.calls.map(([input]) => String(input))).toEqual([
      expect.stringContaining("/price/v3"),
      `${DEXSCREENER_SOLANA_TOKENS_URL}/${TSLAX}`,
    ]);
  });

  it("leaves a mint missing when Jupiter succeeds but omits it (no DexScreener fill)", async () => {
    const fetcher = mockFetch((url) => {
      if (url.includes("/price/v3")) return json(200, { [USDC]: { usdPrice: 0.9998 } });
      throw new Error(`unexpected fetch ${url}`);
    });
    const prices = await fetchJupiterPricesUsd([USDC, TSLAX], fetcher);
    expect(prices.get(USDC)).toBe(0.9998);
    expect(prices.has(TSLAX)).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("returns an empty map and does not throw when Jupiter omits the mint", async () => {
    const fetcher = mockFetch((url) => {
      if (url.includes("/price/v3")) return json(200, {});
      throw new Error(`unexpected fetch ${url}`);
    });
    await expect(fetchJupiterPricesUsd([UNKNOWN], fetcher)).resolves.toEqual(new Map());
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("returns an empty map when Jupiter fails and DexScreener has no usable pair", async () => {
    const fetcher = mockFetch((url) => {
      if (url.includes("/price/v3")) return json(503, { error: "unavailable" });
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
    const keylessHeaders = (fetcher.mock.calls[0]?.[1]?.headers ?? {}) as Record<string, string>;
    expect(keylessHeaders["x-api-key"]).toBeUndefined();
    expect(Object.keys(keylessHeaders).some((name) => name.toLowerCase().includes("next_public"))).toBe(false);

    resetJupiterRuntime();
    resetTokenPriceRuntime({ jupiterSpacingMs: 0, dexScreenerSpacingMs: 0 });
    await fetchJupiterPricesUsd([TSLAX], fetcher, "unit-test-jupiter-key");
    const keyedHeaders = (fetcher.mock.calls[1]?.[1]?.headers ?? {}) as Record<string, string>;
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

  it("does not cache a failed lookup, so the next call retries Jupiter", async () => {
    let jupiterCalls = 0;
    const fetcher = mockFetch((url) => {
      if (url.includes("/price/v3")) {
        jupiterCalls += 1;
        return json(429, { error: "rate limited" });
      }
      if (url.startsWith(DEXSCREENER_SOLANA_TOKENS_URL)) return json(200, []);
      throw new Error(`unexpected fetch ${url}`);
    });
    await fetchJupiterPricesUsd([TSLAX], fetcher);
    await fetchJupiterPricesUsd([TSLAX], fetcher);
    expect(jupiterCalls).toBe(2);
  });
});
