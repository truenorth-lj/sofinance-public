import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jupiterRateGateWaitMs, jupiterRequest, noteJupiterRateHeaders, resetJupiterRateGate } from "./client";
import { jupiterQuote } from "../swap/client";
import { resetJupiterRuntime } from "./index";

const NOW = new Date("2026-10-21T13:35:00Z").getTime();
const resetIn = (ms: number) => String((NOW + ms) / 1000);
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
const quoteRequest = (fetcher: unknown, budget?: { deadlineAt: number; retriesLeft: number }) => jupiterRequest({
  path: "/swap/v1/quote", query: { inputMint: "A", outputMint: "B", amount: "1" },
  fetcher: fetcher as typeof fetch, cacheTtlMs: null, ...(budget ? { budget } : {}),
});

beforeEach(() => {
  vi.stubEnv("JUPITER_API_KEY", undefined);
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  resetJupiterRateGate(() => 0);
});
afterEach(() => {
  vi.unstubAllEnvs();
  resetJupiterRuntime();
  vi.useRealTimers();
});

describe("Jupiter quota window gate", () => {
  it("tracks the most recent window and its lowest remaining count", () => {
    noteJupiterRateHeaders(3, (NOW + 4_000) / 1000);
    noteJupiterRateHeaders(5, (NOW + 4_000) / 1000);
    expect(jupiterRateGateWaitMs(NOW)).toBe(0);
    noteJupiterRateHeaders(0, (NOW + 4_000) / 1000);
    expect(jupiterRateGateWaitMs(NOW)).toBe(4_000);
    noteJupiterRateHeaders(9, (NOW + 9_000) / 1000);
    expect(jupiterRateGateWaitMs(NOW)).toBe(0);
  });

  it("waits for the window reset instead of sending a request that can only 429", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(json({ ok: 1 }, 200, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": resetIn(3_000) }))
      .mockResolvedValueOnce(json({ ok: 2 }));
    await expect(quoteRequest(fetcher)).resolves.toEqual({ ok: 1 });
    const second = quoteRequest(fetcher);
    await vi.advanceTimersByTimeAsync(2_999);
    expect(fetcher).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    await expect(second).resolves.toEqual({ ok: 2 });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("fails fast without calling Jupiter when the reset is past the request deadline", async () => {
    noteJupiterRateHeaders(0, (NOW + 9_000) / 1000);
    const fetcher = vi.fn();
    await expect(quoteRequest(fetcher, { deadlineAt: NOW + 8_000, retriesLeft: 3 }))
      .rejects.toMatchObject({ name: "JupiterHttpError", status: 429 });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("selected 429: waits for the window reset when it fits the deadline (not a 400 ms retry)", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(json({ error: "rate" }, 429, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": resetIn(2_000) }))
      .mockResolvedValueOnce(json({ ok: 3 }));
    const pending = quoteRequest(fetcher, { deadlineAt: NOW + 8_000, retriesLeft: 3 });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetcher).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(pending).resolves.toEqual({ ok: 3 });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("selected 429: gives up at once when the reset does not fit the deadline", async () => {
    const fetcher = vi.fn()
      .mockResolvedValue(json({ error: "rate" }, 429, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": resetIn(30_000) }));
    await expect(quoteRequest(fetcher, { deadlineAt: NOW + 8_000, retriesLeft: 3 }))
      .rejects.toMatchObject({ status: 429 });
    expect(fetcher).toHaveBeenCalledOnce();
  });
});

describe("preview quote cache", () => {
  const base = { inputMint: "In", outputMint: "Out", amount: "10", slippageBps: 50, platformFeeBps: 20, maxAccounts: 24 };

  it("shares identical preview quotes (fee and dex filters included in the key) for a few seconds", async () => {
    const fetcher = vi.fn(async () => json({ outAmount: "7" }));
    const params = { ...base, previewCache: true, fetcher: fetcher as unknown as typeof fetch };
    await Promise.all([jupiterQuote(params), jupiterQuote(params)]);
    await jupiterQuote(params);
    expect(fetcher).toHaveBeenCalledOnce();
    await jupiterQuote({ ...params, platformFeeBps: 0 });
    await jupiterQuote({ ...params, excludeDexes: "Raydium CLMM" });
    expect(fetcher).toHaveBeenCalledTimes(3);
    vi.advanceTimersByTime(5_000);
    await jupiterQuote(params);
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it("never caches quotes that are not marked preview (the build path)", async () => {
    const fetcher = vi.fn(async () => json({ outAmount: "7" }));
    const params = { ...base, fetcher: fetcher as unknown as typeof fetch };
    await jupiterQuote(params);
    await jupiterQuote(params);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
