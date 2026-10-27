import { describe, expect, it, vi } from "vitest";
import { JUPITER_ROUTE_ATTEMPTS, isTxOversizeError, withJupiterRouteRetries } from "./jupiter-route-retry";

describe("jupiter-route-retry", () => {
  it("tightens maxAccounts then onlyDirectRoutes", () => {
    expect(JUPITER_ROUTE_ATTEMPTS.map((item) => [item.maxAccounts, item.onlyDirectRoutes ?? false])).toEqual([
      [48, false],
      [32, false],
      [24, false],
      [20, true],
    ]);
  });

  it("retries only on oversize and succeeds on a later constraint", async () => {
    const fn = vi.fn(async (constraints: { maxAccounts: number }) => {
      if (constraints.maxAccounts > 24) {
        throw new Error("Complete swap + open-position transaction 1284 bytes, exceeds 1,232 byte limit");
      }
      return { ok: true, maxAccounts: constraints.maxAccounts };
    });
    await expect(withJupiterRouteRetries(fn)).resolves.toEqual({ ok: true, maxAccounts: 24 });
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("recovers the live USDC oversize fixture sizes (1284 and 1358) after tightening", async () => {
    const sizes = [1_180, 1_284, 1_358, 1_232];
    let recovered = 0;
    for (const size of sizes) {
      const fn = vi.fn(async (constraints: { maxAccounts: number; onlyDirectRoutes?: boolean }) => {
        const oversize = size > 1_232 && constraints.maxAccounts > 24 && !constraints.onlyDirectRoutes;
        if (oversize) throw new Error(`Complete swap + add transaction ${size} bytes, exceeds 1,232 byte limit`);
        return size;
      });
      const result = await withJupiterRouteRetries(fn);
      if (result === size) recovered += 1;
    }
    expect(recovered).toBe(sizes.length);
  });

  it("rethrows non-size errors without walking the ladder", async () => {
    const fn = vi.fn(async () => {
      throw new Error("Jupiter /build has no available routes (HTTP 400)");
    });
    await expect(withJupiterRouteRetries(fn)).rejects.toThrow(/no available routes/);
    expect(fn).toHaveBeenCalledOnce();
    expect(isTxOversizeError(new Error("encoding overruns Uint8Array"))).toBe(true);
  });
});
