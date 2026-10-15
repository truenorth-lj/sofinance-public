import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { jupiterRequest, type JupiterRetryBudget } from "@sofinance/engine/jupiter/client";
import { JupiterHttpError, retryAfterFromJupiterHeaders } from "@sofinance/engine/jupiter/errors";
import { resetJupiterRuntime, setJupiterLogger } from "@sofinance/engine/jupiter";
import { withSelectedDeadline } from "../selected-deadline";
import { selectedApiError } from "../api-response";

const response = (status: number, headers?: HeadersInit) => Response.json({ outAmount: "9" }, { status, headers });
const budget = (): JupiterRetryBudget => ({ deadlineAt: Date.now() + 8_000, retriesLeft: 1 });
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-13T01:00:00Z"));
  vi.stubEnv("JUPITER_API_KEY", "test-only");
  setJupiterLogger(() => {});
});
afterEach(() => { resetJupiterRuntime(); vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

it("does not shorten a server wait longer than the 4s exponential cap", async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(response(429, { "Retry-After": "6" }))
    .mockResolvedValueOnce(response(200));
  const pending = jupiterRequest({ path: "/swap/v1/quote", fetcher, retry: { maxAttempts: 2 } });
  await vi.advanceTimersByTimeAsync(5_999);
  expect(fetcher).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1);
  await expect(pending).resolves.toEqual({ outAmount: "9" });
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it("never waits or retries selected 429, including a 30s reset", async () => {
  const fetcher = vi.fn().mockResolvedValue(response(429, {
    "x-ratelimit-reset": String(Date.now() / 1000 + 30),
  }));
  await expect(jupiterRequest({ path: "/swap/v1/quote", fetcher, budget: budget() }))
    .rejects.toMatchObject({ status: 429, retryAfterMs: 30_000 });
  expect(fetcher).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it("rejects a wait which cannot fit the selected request plus retry headroom", async () => {
  const fetcher = vi.fn().mockResolvedValue(response(503, { "Retry-After": "8" }));
  await expect(jupiterRequest({ path: "/swap/v1/swap-instructions", fetcher, budget: budget() }))
    .rejects.toMatchObject({ status: 503, retryAfterMs: 8_000 });
  expect(fetcher).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it("respects a full 5xx wait that fits, then completes within the original deadline", async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(response(503, { "Retry-After": "6" }))
    .mockResolvedValueOnce(response(200));
  const shared = budget();
  const pending = jupiterRequest({ path: "/swap/v1/swap-instructions", fetcher, budget: shared });
  await vi.advanceTimersByTimeAsync(5_999);
  expect(fetcher).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1);
  await expect(pending).resolves.toEqual({ outAmount: "9" });
  expect(shared.retriesLeft).toBe(0);
});

it("parallel legs reserve only one shared retry before sleeping", async () => {
  const shared = budget();
  const fetcher = vi.fn().mockImplementation(() => Promise.resolve(response(503, { "Retry-After": "1" })));
  const results = Promise.allSettled([1, 2].map(() =>
    jupiterRequest({ path: "/swap/v1/swap-instructions", fetcher, budget: shared })));
  await vi.advanceTimersByTimeAsync(1_000);
  const settled = await results;
  expect(settled.every((item) => item.status === "rejected")).toBe(true);
  expect(fetcher).toHaveBeenCalledTimes(3);
  expect(shared.retriesLeft).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});

it("a late first failure is returned without consuming the remaining second", async () => {
  const shared = budget();
  const fetcher = vi.fn(async () => {
    await new Promise((resolve) => setTimeout(resolve, 7_000));
    return response(503);
  });
  const pending = jupiterRequest({ path: "/swap/v1/swap-instructions", fetcher, budget: shared });
  const rejected = expect(pending).rejects.toMatchObject({ status: 503 });
  await vi.advanceTimersByTimeAsync(7_000);
  await rejected;
  expect(fetcher).toHaveBeenCalledOnce();
  expect(shared.retriesLeft).toBe(1);
});

it("checks remaining time again after delayed timer delivery", async () => {
  const shared = budget();
  const fetcher = vi.fn().mockResolvedValue(response(503, { "Retry-After": "1" }));
  const pending = jupiterRequest({ path: "/swap/v1/swap-instructions", fetcher, budget: shared });
  const rejected = expect(pending).rejects.toMatchObject({ status: 503 });
  await vi.advanceTimersByTimeAsync(1);
  vi.setSystemTime(shared.deadlineAt);
  await vi.advanceTimersByTimeAsync(1_000);
  await rejected;
  expect(fetcher).toHaveBeenCalledOnce();
});

it("cancels a retry sleep when its caller leaves", async () => {
  const client = new AbortController();
  const fetcher = vi.fn().mockResolvedValue(response(503, { "Retry-After": "1" }));
  const pending = jupiterRequest({ path: "/swap/v1/swap-instructions", fetcher, budget: budget(), signal: client.signal });
  const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
  await vi.advanceTimersByTimeAsync(1);
  client.abort();
  await rejected;
  await vi.advanceTimersByTimeAsync(8_000);
  expect(fetcher).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it("429 ends the selected response and cancels its still-running sibling", async () => {
  const aborted = vi.fn();
  const fast = vi.fn().mockResolvedValue(response(429, { "Retry-After": "30" }));
  const slow = vi.fn((_url: unknown, options?: RequestInit) => new Promise<Response>((_, reject) => {
    options?.signal?.addEventListener("abort", () => { aborted(); reject(options.signal?.reason); }, { once: true });
  }));
  const result = await withSelectedDeadline(new Request("http://localhost/quote"), async (signal, shared) => {
    try {
      await Promise.all([jupiterRequest({ path: "/swap/v1/quote", fetcher: fast, signal, budget: shared }),
        jupiterRequest({ path: "/swap/v1/quote", fetcher: slow, signal, budget: shared })]);
      return Response.json({ unreachable: true });
    } catch (error) { return selectedApiError(error, "Quote failed"); }
  });
  expect(result.status).toBe(503);
  expect(await result.json()).toMatchObject({ code: "jupiter_rate_limited", retryAfterMs: 30_000 });
  expect(aborted).toHaveBeenCalledOnce();
  expect(fast).toHaveBeenCalledOnce();
  expect(slow).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(16_000);
  expect(fast).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it("keeps quota metadata numeric and missing headers unknown", async () => {
  const log = vi.fn(); setJupiterLogger(log);
  const fetcher = vi.fn().mockResolvedValueOnce(response(200, {
    "x-ratelimit-current": "61", "x-ratelimit-remaining": "-1",
    "x-ratelimit-reset": "1791853201", authorization: "secret-upstream",
  })).mockResolvedValueOnce(response(200, { "x-ratelimit-current": "bad" }));
  for (let index = 0; index < 2; index++) await jupiterRequest({
    path: "/swap/v1/quote", query: { wallet: "private-wallet", amount: "200" }, fetcher, budget: budget(),
  });
  expect(log.mock.calls[0]?.[0]).toMatchObject({ status: 200, selected: true,
    rateLimitCurrent: 61, rateLimitRemaining: -1, rateLimitReset: 1791853201, durationMs: expect.any(Number) });
  expect(log.mock.calls[1]?.[0].rateLimitCurrent).toBeUndefined();
  expect(log.mock.calls[1]?.[0].rateLimitRemaining).toBeUndefined();
  expect(JSON.stringify(log.mock.calls)).not.toMatch(/private-wallet|secret-upstream|test-only|authorization/);
});

it("uses the later server wait and rejects invalid or unbounded timer values safely", () => {
  const now = Date.now();
  expect(retryAfterFromJupiterHeaders(new Headers({ "Retry-After": "2",
    "x-ratelimit-reset": String(now / 1000 + 3) }), now)).toBe(3_000);
  expect(retryAfterFromJupiterHeaders(new Headers({ "Retry-After": new Date(now + 4_000).toUTCString() }), now)).toBe(4_000);
  expect(retryAfterFromJupiterHeaders(new Headers({ "x-ratelimit-reset": "-5" }), now)).toBeNull();
  expect(retryAfterFromJupiterHeaders(new Headers({ "x-ratelimit-reset": " " }), now)).toBeNull();
  expect(retryAfterFromJupiterHeaders(new Headers({ "Retry-After": "1e307" }), now)).toBe(Number.MAX_SAFE_INTEGER);
  expect(retryAfterFromJupiterHeaders(new Headers({ "x-ratelimit-reset": "1e307" }), now)).toBe(Number.MAX_SAFE_INTEGER);
});

it.each([400, 401, 403])("does not retry invalid or unauthorized HTTP %s", async (status) => {
  const fetcher = vi.fn().mockResolvedValue(response(status));
  await expect(jupiterRequest({ path: "/swap/v1/swap-instructions", fetcher, budget: budget() })).rejects.toBeInstanceOf(JupiterHttpError);
  expect(fetcher).toHaveBeenCalledOnce();
});
