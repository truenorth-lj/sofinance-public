import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { quoteCacheKey, resetJupiterCache } from "./cache";
import {
  EXIT_JUPITER_CONCURRENCY,
  JUPITER_QUOTE_TTL_MS,
  jupiterQuote,
  jupiterQuotePreferCompact,
  jupiterRequest,
  jupiterSwapInstructions,
  mapPool,
  setJupiterRetryConfig,
} from "./client";
import { JupiterHttpError, retryAfterFromJupiterHeaders } from "./errors";
import { resetJupiterRuntime } from "./index";

afterEach(() => {
  resetJupiterRuntime();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function jsonResponse(body: unknown, status = 200, headers?: HeadersInit) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

describe("jupiterRequest retry", () => {
  it("retries 429 honoring Retry-After, then succeeds", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-10T17:00:00Z"));
    setJupiterRetryConfig({ maxAttempts: 3, baseMs: 200, maxDelayMs: 5_000, budgetMs: 8_000 });
    const fetcher = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ error: "rate" }, 429, { "Retry-After": "1" }))
      .mockResolvedValueOnce(jsonResponse({ outAmount: "9" }));
    const promise = jupiterRequest({
      path: "/swap/v1/quote",
      query: { inputMint: "A", outputMint: "B", amount: "1" },
      fetcher: fetcher as unknown as typeof fetch,
      cacheTtlMs: null,
    });
    await vi.advanceTimersByTimeAsync(999);
    expect(fetcher).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    await expect(promise).resolves.toEqual({ outAmount: "9" });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const headers = new Headers(fetcher.mock.calls[0]?.[1]?.headers as HeadersInit);
    expect(headers.get("x-api-key")).toBeNull();
  });

  it("does not retry HTTP 400", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({ error: "no routes found" }, 400));
    await expect(jupiterRequest({
      path: "/swap/v1/quote",
      query: { inputMint: "A", outputMint: "B", amount: "1" },
      fetcher: fetcher as unknown as typeof fetch,
      cacheTtlMs: null,
    })).rejects.toMatchObject({ name: "JupiterHttpError", status: 400, message: "Jupiter HTTP 400" });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("stops when the AbortSignal fires", async () => {
    vi.useFakeTimers();
    setJupiterRetryConfig({ maxAttempts: 4, baseMs: 1_000, maxDelayMs: 1_000, budgetMs: 8_000 });
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({}, 429));
    const controller = new AbortController();
    const promise = jupiterRequest({
      path: "/swap/v1/quote",
      fetcher: fetcher as unknown as typeof fetch,
      signal: controller.signal,
      cacheTtlMs: null,
    });
    const expectAbort = expect(promise).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(10);
    controller.abort();
    await expectAbort;
  });

  it("sends x-api-key when provided and never puts it in thrown messages", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({}, 503));
    await expect(jupiterRequest({
      path: "/price/v3",
      apiKey: "secret-jupiter-key",
      fetcher: fetcher as unknown as typeof fetch,
      retry: { maxAttempts: 1, budgetMs: 100, baseMs: 1, maxDelayMs: 1 },
    })).rejects.toThrow(JupiterHttpError);
    const headers = new Headers(fetcher.mock.calls[0]?.[1]?.headers as HeadersInit);
    expect(headers.get("x-api-key")).toBe("secret-jupiter-key");
    try {
      await jupiterRequest({
        path: "/price/v3",
        apiKey: "secret-jupiter-key",
        fetcher: fetcher as unknown as typeof fetch,
        retry: { maxAttempts: 1, budgetMs: 100, baseMs: 1, maxDelayMs: 1 },
      });
    } catch (error) {
      expect(String(error)).not.toMatch(/secret-jupiter-key/);
    }
  });
});

describe("quote cache and coalescing", () => {
  it("dedupes in-flight quote reads and then serves TTL hits", async () => {
    let resolveFirst: (value: Response) => void = () => undefined;
    const fetcher = vi.fn(() => new Promise<Response>((resolve) => {
      resolveFirst = resolve;
    }));
    const params = { inputMint: "In", outputMint: "Out", amount: "10", slippageBps: 50, fetcher: fetcher as unknown as typeof fetch };
    const first = jupiterQuote(params);
    const second = jupiterQuote(params);
    expect(fetcher).toHaveBeenCalledOnce();
    resolveFirst(jsonResponse({ outAmount: "7" }));
    await expect(Promise.all([first, second])).resolves.toEqual([{ outAmount: "7" }, { outAmount: "7" }]);
    await expect(jupiterQuote(params)).resolves.toEqual({ outAmount: "7" });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("refetches after the quote TTL", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-10T17:00:00Z"));
    const fetcher = vi.fn(async () => jsonResponse({ outAmount: "1" }));
    const params = { inputMint: "In", outputMint: "Out", amount: "10", slippageBps: 50, maxAccounts: 16, fetcher: fetcher as unknown as typeof fetch };
    await jupiterQuote(params);
    vi.advanceTimersByTime(JUPITER_QUOTE_TTL_MS - 1);
    await jupiterQuote(params);
    expect(fetcher).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(2);
    await jupiterQuote(params);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("does not cache POST swap-instructions", async () => {
    const fetcher = vi.fn();
    fetcher.mockImplementation(async () => jsonResponse({ swapInstruction: {} }));
    const body = { userPublicKey: "Wallet", quoteResponse: { outAmount: "1" } };
    await jupiterSwapInstructions(body, { fetcher: fetcher as unknown as typeof fetch });
    await jupiterSwapInstructions(body, { fetcher: fetcher as unknown as typeof fetch });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ method: "POST" });
  });

  it("does not cache a failed quote", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(jsonResponse({}, 503))
      .mockResolvedValueOnce(jsonResponse({ outAmount: "2" }));
    const params = {
      inputMint: "In", outputMint: "Out", amount: "10",
      fetcher: fetcher as unknown as typeof fetch,
    };
    setJupiterRetryConfig({ maxAttempts: 1, budgetMs: 100, baseMs: 1, maxDelayMs: 1 });
    await expect(jupiterQuote(params)).rejects.toThrow(/Jupiter HTTP 503/);
    resetJupiterCache();
    setJupiterRetryConfig({ maxAttempts: 1, budgetMs: 100, baseMs: 1, maxDelayMs: 1 });
    await expect(jupiterQuote(params)).resolves.toEqual({ outAmount: "2" });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("keys the quote cache on mint/amount/slippage/maxAccounts", () => {
    expect(quoteCacheKey({ inputMint: "A", outputMint: "U", amount: "1", slippageBps: 50, maxAccounts: 16 }))
      .not.toBe(quoteCacheKey({ inputMint: "A", outputMint: "U", amount: "1", slippageBps: 50, maxAccounts: 20 }));
  });
});

describe("quote compact fallback and pool", () => {
  it("retries a 400 quote with a wider account budget", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ error: "no routes found" }, 400))
      .mockResolvedValueOnce(jsonResponse({ outAmount: "5" }));
    await expect(jupiterQuotePreferCompact({
      inputMint: "A", outputMint: "U", amount: "9",
      fetcher: fetcher as unknown as typeof fetch,
    })).resolves.toEqual({ outAmount: "5" });
    expect(String(fetcher.mock.calls[0]?.[0])).toContain("maxAccounts=16");
    expect(String(fetcher.mock.calls[1]?.[0])).toContain("maxAccounts=20");
  });

  it("runs work with a concurrency cap", async () => {
    let inflight = 0;
    let peak = 0;
    const values = await mapPool([1, 2, 3, 4], EXIT_JUPITER_CONCURRENCY, async (n) => {
      inflight += 1;
      peak = Math.max(peak, inflight);
      await Promise.resolve();
      inflight -= 1;
      return n * 2;
    });
    expect(values).toEqual([2, 4, 6, 8]);
    expect(peak).toBeLessThanOrEqual(EXIT_JUPITER_CONCURRENCY);
  });
});

describe("retry-after headers", () => {
  it("reads Retry-After seconds and x-ratelimit-reset", () => {
    const now = Date.parse("2026-10-10T17:00:00Z");
    expect(retryAfterFromJupiterHeaders(new Headers({ "Retry-After": "2" }), now)).toBe(2_000);
    expect(retryAfterFromJupiterHeaders(new Headers({ "x-ratelimit-reset": String(now / 1000 + 3) }), now)).toBe(3_000);
  });
});
