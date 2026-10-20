import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { JupiterHttpError } from "@sofinance/engine/jupiter/errors";
import { SELECTED_RATE_LIMIT_RETRY_MS } from "@sofinance/engine/jupiter/client";
import { JupiterNoRouteError } from "@sofinance/engine/swap/jupiter";
import {
  HIGH_ACCOUNT_DEXES, SELECTED_PREFLIGHT_STRATEGY_BUDGET, selectedOversizeFollowups,
  txOversizeBytes, withSelectedRouteRetries,
} from "./selected-route-retry";

describe("withSelectedRouteRetries", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("uses the compact budget first", async () => {
    const fn = vi.fn(async (constraints: { maxAccounts: number }) => constraints.maxAccounts);
    await expect(withSelectedRouteRetries(fn)).resolves.toBe(24);
    expect(fn).toHaveBeenCalledOnce();
    expect(fn.mock.calls[0]?.[0]).toEqual({ maxAccounts: 24 });
  });

  it("widens maxAccounts when Jupiter has no route", async () => {
    const fn = vi.fn(async (constraints: { maxAccounts: number }) => {
      if (constraints.maxAccounts < 32) throw new JupiterNoRouteError();
      return constraints.maxAccounts;
    });
    await expect(withSelectedRouteRetries(fn)).resolves.toBe(32);
    expect(fn.mock.calls.map((call) => call[0]?.maxAccounts)).toEqual([24, 32]);
  });

  it("treats HTTP 400 NO_ROUTES_FOUND as no-route and widens", async () => {
    const fn = vi.fn(async (constraints: { maxAccounts: number }) => {
      if (constraints.maxAccounts < 32) {
        throw new JupiterHttpError(400, "/swap/v1/quote", null, "No routes found");
      }
      return constraints.maxAccounts;
    });
    await expect(withSelectedRouteRetries(fn)).resolves.toBe(32);
  });

  it("does not requote the same budget after oversize; tries DEX-filtered compact first for fee+tip overshoot", async () => {
    const fn = vi.fn(async (
      constraints: { maxAccounts: number; onlyDirectRoutes?: boolean; excludeDexes?: string },
      attempt: { skipProbe: boolean },
    ) => {
      void attempt;
      if (constraints.excludeDexes === HIGH_ACCOUNT_DEXES && constraints.maxAccounts === 24 && !constraints.onlyDirectRoutes) {
        return constraints;
      }
      throw new Error("Complete swap + add transaction 1284 bytes, exceeds 1,232 byte limit");
    });
    await expect(withSelectedRouteRetries(fn)).resolves.toEqual({
      maxAccounts: 24, excludeDexes: HIGH_ACCOUNT_DEXES,
    });
    expect(fn.mock.calls.map((call) => [
      call[0]?.maxAccounts, call[0]?.onlyDirectRoutes ?? false, call[0]?.excludeDexes ?? "",
    ])).toEqual([
      [24, false, ""],
      [24, false, HIGH_ACCOUNT_DEXES],
    ]);
    expect(fn.mock.calls[1]?.[1]).toEqual({ skipProbe: true });
  });

  it("falls through to 20-account direct when compact followups stay oversize", async () => {
    const fn = vi.fn(async (constraints: { maxAccounts: number; onlyDirectRoutes?: boolean }) => {
      if (constraints.maxAccounts > 20) {
        throw new Error("Complete swap + add transaction 1284 bytes, exceeds 1,232 byte limit");
      }
      return constraints;
    });
    await expect(withSelectedRouteRetries(fn)).resolves.toEqual({ maxAccounts: 20, onlyDirectRoutes: true });
  });

  it("does not widen after an oversize 32-account route", async () => {
    const fn = vi.fn(async (constraints: { maxAccounts: number; onlyDirectRoutes?: boolean; excludeDexes?: string }) => {
      if (constraints.maxAccounts === 24) throw new JupiterNoRouteError();
      if (constraints.maxAccounts >= 32 && !constraints.onlyDirectRoutes && !constraints.excludeDexes) {
        throw new Error("Complete swap + add transaction 1284 bytes, exceeds 1,232 byte limit");
      }
      return constraints.maxAccounts;
    });
    await expect(withSelectedRouteRetries(fn)).resolves.toBe(20);
    expect(fn.mock.calls.map((call) => call[0]?.maxAccounts)).toEqual([24, 32, 24, 20]);
    expect(fn.mock.calls[2]?.[0]).toMatchObject({ maxAccounts: 24, excludeDexes: HIGH_ACCOUNT_DEXES });
    expect(fn.mock.calls.some((call) => call[0]?.maxAccounts === 48)).toBe(false);
  });

  it("caps oversize followups at the preflight strategy budget and returns no-route", async () => {
    const fn = vi.fn(async () => {
      throw new Error("Complete swap + add transaction 1400 bytes, exceeds 1,232 byte limit");
    });
    await expect(withSelectedRouteRetries(fn)).rejects.toBeInstanceOf(JupiterNoRouteError);
    expect(fn).toHaveBeenCalledTimes(SELECTED_PREFLIGHT_STRATEGY_BUDGET);
  });

  it("retries a selected 429 once with a short backoff, then succeeds", async () => {
    vi.useFakeTimers();
    const fn = vi.fn(async () => {
      if (fn.mock.calls.length === 1) {
        throw new JupiterHttpError(429, "/swap/v1/quote", 30_000);
      }
      return "ok";
    });
    const pending = withSelectedRouteRetries(fn);
    await vi.advanceTimersByTimeAsync(SELECTED_RATE_LIMIT_RETRY_MS - 1);
    expect(fn).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("surfaces jupiter_rate_limited after one short 429 retry still fails", async () => {
    vi.useFakeTimers();
    const fn = vi.fn(async () => {
      throw new JupiterHttpError(429, "/swap/v1/quote", 30_000);
    });
    const pending = withSelectedRouteRetries(fn);
    const rejected = expect(pending).rejects.toMatchObject({ status: 429, retryAfterMs: 30_000 });
    await vi.advanceTimersByTimeAsync(SELECTED_RATE_LIMIT_RETRY_MS);
    await rejected;
    expect(fn).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("rethrows non-route failures without walking the ladder", async () => {
    const fn = vi.fn(async () => {
      throw new Error("Price impact relative to probe route exceeds 5% limit");
    });
    await expect(withSelectedRouteRetries(fn)).rejects.toThrow(/Price impact/);
    expect(fn).toHaveBeenCalledOnce();
  });

  it("throws JupiterNoRouteError after compact-first widening is exhausted", async () => {
    const fn = vi.fn(async (constraints: { maxAccounts: number }) => {
      void constraints;
      throw new JupiterNoRouteError();
    });
    await expect(withSelectedRouteRetries(fn)).rejects.toBeInstanceOf(JupiterNoRouteError);
    expect(fn.mock.calls.map((call) => call[0]?.maxAccounts)).toEqual([24, 32, 48]);
  });
});

describe("selectedOversizeFollowups", () => {
  it("orders fee+tip overshoot toward compact DEX filters before 20-account direct", () => {
    const keys = selectedOversizeFollowups(24, 1284).map((item) =>
      `${item.maxAccounts}:${item.onlyDirectRoutes === true}:${item.excludeDexes ?? ""}`);
    expect(keys).toEqual([
      `24:false:${HIGH_ACCOUNT_DEXES}`,
      "20:true:",
      `20:true:${HIGH_ACCOUNT_DEXES}`,
    ]);
    expect(selectedOversizeFollowups(32, 1400).every((item) => item.maxAccounts <= 32)).toBe(true);
    expect(selectedOversizeFollowups(32, 1400).some((item) => item.maxAccounts === 48)).toBe(false);
    expect(selectedOversizeFollowups(32, 1400)[0]).toEqual({ maxAccounts: 20, onlyDirectRoutes: true });
  });

  it("reads the reported oversize byte count", () => {
    expect(txOversizeBytes(new Error("Complete swap + add transaction 1284 bytes, exceeds 1,232 byte limit"))).toBe(1284);
    expect(txOversizeBytes(new Error("other"))).toBeNull();
  });
});
