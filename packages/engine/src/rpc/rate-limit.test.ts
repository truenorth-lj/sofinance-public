import { afterEach, describe, expect, it } from "vitest";
import { TokenBucket, rateLimiterFor, resetRpcRateLimiters } from "./rate-limit";

afterEach(() => resetRpcRateLimiters());

describe("TokenBucket", () => {
  it("allows a burst, then refills at rps", () => {
    let now = 0;
    const bucket = new TokenBucket(10, 3, () => now);
    expect([bucket.tryTake(), bucket.tryTake(), bucket.tryTake(), bucket.tryTake()]).toEqual([true, true, true, false]);
    now += 100; // 10 rps → one token per 100 ms
    expect(bucket.available()).toBe(true);
    expect(bucket.tryTake()).toBe(true);
    expect(bucket.tryTake()).toBe(false);
    now += 10_000;
    expect([bucket.tryTake(), bucket.tryTake(), bucket.tryTake(), bucket.tryTake()]).toEqual([true, true, true, false]);
  });

  it("take() waits for the next token instead of failing, in call order", async () => {
    const bucket = new TokenBucket(50, 1);
    const started = Date.now();
    await bucket.take();
    await bucket.take();
    await bucket.take();
    expect(Date.now() - started).toBeGreaterThanOrEqual(35); // two waits of ~20 ms
  });

  it("take() honours abort", async () => {
    const bucket = new TokenBucket(1, 1);
    await bucket.take();
    const controller = new AbortController();
    const pending = bucket.take(controller.signal);
    controller.abort(new Error("left"));
    await expect(pending).rejects.toThrow("left");
  });
});

describe("rateLimiterFor", () => {
  it("is shared per key, absent without rps, and replaced when the rate changes", () => {
    expect(rateLimiterFor("a", null)).toBeNull();
    const first = rateLimiterFor("a", 5);
    expect(rateLimiterFor("a", 5)).toBe(first);
    expect(rateLimiterFor("a", 8)).not.toBe(first);
    expect(rateLimiterFor("b", 5)).not.toBe(rateLimiterFor("a", 8));
  });
});
