import { afterEach, describe, expect, it, vi } from "vitest";
import { clampDelayMs, sleep, withTimeout } from "./async";
import { sleep as retrySleep } from "./rpc/retry";

afterEach(() => vi.useRealTimers());

describe("clampDelayMs", () => {
  it("keeps non-negative delays and turns negative, NaN and infinite ones into 0", () => {
    expect(clampDelayMs(0)).toBe(0);
    expect(clampDelayMs(1_500)).toBe(1_500);
    expect(clampDelayMs(-20)).toBe(0);
    expect(clampDelayMs(Number.NaN)).toBe(0);
    expect(clampDelayMs(Number.POSITIVE_INFINITY)).toBe(0);
    expect(clampDelayMs(Number.NEGATIVE_INFINITY)).toBe(0);
  });
});

describe("sleep", () => {
  it("resolves after the delay", async () => {
    vi.useFakeTimers();
    let done = false;
    const pending = sleep(1_000).then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(done).toBe(true);
  });

  it("never schedules a negative timer", async () => {
    const spy = vi.spyOn(globalThis, "setTimeout");
    await sleep(-50);
    expect(spy.mock.calls.at(-1)?.[1]).toBe(0);
    spy.mockRestore();
  });

  it("rejects at once when the signal is already aborted, with the signal's Error reason", async () => {
    const controller = new AbortController();
    controller.abort(new Error("stop"));
    await expect(sleep(60_000, controller.signal)).rejects.toThrow("stop");
  });

  it("rejects with an AbortError and clears the timer when aborted while waiting", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const pending = sleep(60_000, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("is the same function rpc/retry re-exports", () => {
    expect(retrySleep).toBe(sleep);
  });
});

describe("withTimeout", () => {
  const never = () => new Promise<never>(() => undefined);

  it("settles like the work when it finishes first, and clears its timer", async () => {
    vi.useFakeTimers();
    await expect(withTimeout(Promise.resolve(1), 5)).resolves.toBe(1);
    await expect(withTimeout(Promise.reject(new Error("boom")), 5)).rejects.toThrow("boom");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects with the given message (default \"timeout\") after the limit", async () => {
    await expect(withTimeout(never(), 5, { message: "Robinhood Chain tick window read timed out" }))
      .rejects.toThrow("Robinhood Chain tick window read timed out");
    await expect(withTimeout(never(), 5)).rejects.toThrow("timeout");
  });

  it("treats a negative limit as an immediate timeout", async () => {
    const spy = vi.spyOn(globalThis, "setTimeout");
    await expect(withTimeout(never(), -1)).rejects.toThrow("timeout");
    expect(spy.mock.calls.at(-1)?.[1]).toBe(0);
    spy.mockRestore();
  });

  it("rejects with the abort reason when the signal aborts, and removes its listener", async () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const pending = withTimeout(never(), 60_000, { message: "x", signal: controller.signal });
    controller.abort(new Error("job timeout"));
    await expect(pending).rejects.toThrow("job timeout");
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("falls back to the timeout error when the abort has no reason", async () => {
    const signal = { reason: undefined, addEventListener: (_: string, fn: () => void) => fn(), removeEventListener: () => undefined } as unknown as AbortSignal;
    await expect(withTimeout(never(), 60_000, { message: "slow", signal })).rejects.toThrow("slow");
  });
});
