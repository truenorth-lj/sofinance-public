import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { JupiterHttpError } from "@sofinance/engine/jupiter/errors";
import { JupiterNoRouteError } from "@sofinance/engine/swap/jupiter";
import { withSelectedRouteRetries } from "./selected-route-retry";

describe("withSelectedRouteRetries", () => {
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

  it("tightens only after an oversize transaction, including 20-account direct", async () => {
    const fn = vi.fn(async (constraints: { maxAccounts: number; onlyDirectRoutes?: boolean }) => {
      if (constraints.maxAccounts > 20) {
        throw new Error("Complete swap + add transaction 1284 bytes, exceeds 1,232 byte limit");
      }
      return constraints;
    });
    await expect(withSelectedRouteRetries(fn)).resolves.toEqual({ maxAccounts: 20, onlyDirectRoutes: true });
    expect(fn.mock.calls.map((call) => [call[0]?.maxAccounts, call[0]?.onlyDirectRoutes ?? false])).toEqual([
      [24, false],
      [20, true],
    ]);
  });

  it("does not widen after an oversize 32-account route", async () => {
    const fn = vi.fn(async (constraints: { maxAccounts: number; onlyDirectRoutes?: boolean }) => {
      if (constraints.maxAccounts === 24) throw new JupiterNoRouteError();
      if (constraints.maxAccounts >= 32 && !constraints.onlyDirectRoutes) {
        throw new Error("Complete swap + add transaction exceeds 1,232 byte limit");
      }
      return constraints.maxAccounts;
    });
    await expect(withSelectedRouteRetries(fn)).resolves.toBe(20);
    expect(fn.mock.calls.map((call) => call[0]?.maxAccounts)).toEqual([24, 32, 20]);
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
