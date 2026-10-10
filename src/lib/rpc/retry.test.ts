import { afterEach, describe, expect, it, vi } from "vitest";
import { RpcHttpError, RpcUnavailableError } from "./errors";
import { invokeWithPolicy } from "./connection";
import { resetRpcCache } from "./cache";
import { setRpcLogger } from "./logger";
import { computeBackoffMs, invokeWithRetries, parseRetryAfter, setRpcRetryConfig } from "./retry";

afterEach(() => {
  resetRpcCache();
  setRpcLogger(null);
  setRpcRetryConfig(null);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("computeBackoffMs", () => {
  it("uses full jitter against the exponential cap", () => {
    const config = { maxAttempts: 4, baseMs: 200, maxDelayMs: 2_000, budgetMs: 8_000 };
    expect(computeBackoffMs(1, { random: () => 0.5, config })).toBe(100);
    expect(computeBackoffMs(2, { random: () => 0.5, config })).toBe(200);
    expect(computeBackoffMs(3, { random: () => 0.5, config })).toBe(400);
    expect(computeBackoffMs(8, { random: () => 1, config })).toBe(2_000);
  });

  it("honors Retry-After when present, capped at maxDelayMs", () => {
    const config = { maxAttempts: 4, baseMs: 200, maxDelayMs: 2_000, budgetMs: 8_000 };
    expect(computeBackoffMs(1, { retryAfterMs: 1_500, random: () => 0, config })).toBe(1_500);
    expect(computeBackoffMs(1, { retryAfterMs: 9_000, random: () => 0, config })).toBe(2_000);
  });
});

describe("parseRetryAfter", () => {
  it("parses delta-seconds and HTTP-date", () => {
    expect(parseRetryAfter("2")).toBe(2_000);
    expect(parseRetryAfter("0")).toBe(0);
    const now = Date.parse("Wed, 21 Oct 2015 07:28:00 GMT");
    expect(parseRetryAfter("Wed, 21 Oct 2015 07:28:02 GMT", now)).toBe(2_000);
    expect(parseRetryAfter("nope")).toBeNull();
  });
});

describe("429 backoff and failover", () => {
  it("retries 429 with jittered backoff then fails over", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    setRpcRetryConfig({ maxAttempts: 4, baseMs: 200, maxDelayMs: 2_000, budgetMs: 8_000 });
    const primary = vi.fn(async () => {
      throw new Error("429 Too Many Requests: Too many requests for a specific RPC call");
    });
    const fallback = vi.fn(async () => ({ owner: "fallback" }));
    const promise = invokeWithPolicy({
      method: "getAccountInfo",
      primary,
      fallback,
      primaryId: "solami",
      fallbackId: "default",
    });
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toMatchObject({
      value: { owner: "fallback" },
      servedBy: "default",
      fallback: true,
      errorKind: "rate-limit",
    });
    expect(primary).toHaveBeenCalledTimes(4);
    expect(fallback).toHaveBeenCalledOnce();
  });

  it("respects Retry-After on RpcHttpError before the next attempt", async () => {
    vi.useFakeTimers();
    setRpcRetryConfig({ maxAttempts: 3, baseMs: 200, maxDelayMs: 5_000, budgetMs: 8_000 });
    const primary = vi.fn()
      .mockRejectedValueOnce(new RpcHttpError(429, "RPC HTTP 429", 1_250))
      .mockResolvedValueOnce({ owner: "retried" });
    const promise = invokeWithRetries(primary, { method: "getAccountInfo", providerId: "solami" });
    await vi.advanceTimersByTimeAsync(1_249);
    expect(primary).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    await expect(promise).resolves.toEqual({ value: { owner: "retried" }, retries: 1 });
    expect(primary).toHaveBeenCalledTimes(2);
  });

  it("surfaces a user-facing error when every provider is exhausted", async () => {
    setRpcRetryConfig({ maxAttempts: 1 });
    await expect(invokeWithPolicy({
      method: "getAccountInfo",
      primary: async () => {
        throw new Error("429 Too Many Requests");
      },
      fallback: async () => {
        throw new Error("503 unavailable");
      },
      primaryId: "solami",
      fallbackId: "default",
    })).rejects.toBeInstanceOf(RpcUnavailableError);
  });
});

describe("abort handling", () => {
  it("stops during backoff when the signal aborts", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(1);
    setRpcRetryConfig({ maxAttempts: 4, baseMs: 200, maxDelayMs: 2_000, budgetMs: 8_000 });
    const controller = new AbortController();
    const primary = vi.fn(async () => {
      throw new Error("429 rate limited");
    });
    const promise = invokeWithPolicy({
      method: "getAccountInfo",
      primary,
      fallback: async () => ({ owner: "nope" }),
      primaryId: "solami",
      fallbackId: "default",
      signal: controller.signal,
    });
    const rejected = expect(promise).rejects.toMatchObject({ name: "AbortError" });
    await Promise.resolve();
    controller.abort();
    await vi.runAllTimersAsync();
    await rejected;
    expect(primary).toHaveBeenCalledOnce();
  });

  it("does not start work when already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const primary = vi.fn(async () => ({ owner: "x" }));
    await expect(invokeWithPolicy({
      method: "getAccountInfo",
      primary,
      primaryId: "solami",
      signal: controller.signal,
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(primary).not.toHaveBeenCalled();
  });
});
