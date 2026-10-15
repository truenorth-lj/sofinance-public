import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { assertOwnPoolRoute, isPoolTokenPair, ownPoolConstraints, preferOwnPoolRoute } from "@sofinance/engine/swap/own-pool";
import { JupiterNoRouteError, type QuoteRoute } from "@sofinance/engine/swap/jupiter";
import { JupiterHttpError } from "@sofinance/engine/jupiter";

const pool = { poolId: "pool", mintA: "a", mintB: "b" };
const route = (ammKey = "pool", bps = 10000) => ({ routePlan: [{ bps, swapInfo: { ammKey } }] }) as QuoteRoute;

describe("own-pool routes", () => {
  it("constrains both pool-token directions and preserves smaller account budgets", () => {
    expect(isPoolTokenPair(pool, "a", "b")).toBe(true);
    expect(isPoolTokenPair(pool, "b", "a")).toBe(true);
    expect(isPoolTokenPair(pool, "usdc", "b")).toBe(false);
    expect(isPoolTokenPair(pool, "a", "a")).toBe(false);
    expect(ownPoolConstraints({ maxAccounts: 48 })).toEqual({ maxAccounts: 20, onlyDirectRoutes: true, dexes: "Raydium CLMM" });
    expect(ownPoolConstraints({ maxAccounts: 12 }).maxAccounts).toBe(12);
  });
  it("accepts only a single full-weight hop through the original pool", () => {
    expect(() => assertOwnPoolRoute(route(), "pool")).not.toThrow();
    for (const candidate of [route("other"), route("pool", 5000), { routePlan: [] },
      { routePlan: [...route().routePlan, ...route().routePlan] }]) {
      expect(() => assertOwnPoolRoute(candidate as QuoteRoute, "pool")).toThrow("only the original pool");
    }
  });
  it("uses the own pool first without requesting a free route", async () => {
    const request = vi.fn().mockResolvedValue(route());
    await preferOwnPoolRoute("pool", request, { maxAccounts: 48 });
    expect(request).toHaveBeenCalledExactlyOnceWith(ownPoolConstraints());
  });
  it.each([new JupiterNoRouteError(), new JupiterHttpError(400, "/quote", null, "No routes found")])(
    "falls back when Jupiter has no route (%s)", async error => {
      const free = route("other");
      const request = vi.fn().mockRejectedValueOnce(error).mockResolvedValueOnce(free);
      expect(await preferOwnPoolRoute("pool", request, { maxAccounts: 48 })).toBe(free);
      expect(request).toHaveBeenLastCalledWith({ maxAccounts: 48 });
    });
  it("falls back if the DEX-filtered candidate uses a different pool", async () => {
    const free = route("free");
    const request = vi.fn().mockResolvedValueOnce(route("other")).mockResolvedValueOnce(free);
    expect(await preferOwnPoolRoute("pool", request, { maxAccounts: 32 })).toBe(free);
  });
  it("propagates upstream failures without hiding them with fallback", async () => {
    const request = vi.fn().mockRejectedValue(new Error("timeout"));
    await expect(preferOwnPoolRoute("pool", request)).rejects.toThrow("timeout");
    expect(request).toHaveBeenCalledTimes(1);
  });
});
