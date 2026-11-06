import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ unstable_cache: <T,>(fn: T) => fn }));

import { fetchJupiterStockRows, isStockSourceUnavailable, STOCK_JUPITER_SPACING_MS } from "./source";
import { STOCK_UNIVERSE } from "./universe";
import { JupiterHttpError } from "@sofinance/engine/jupiter/errors";

describe("fetchJupiterStockRows", () => {
  it("reads the whole universe in 3 comma-separated search calls, spaced for the 1 request/s free tier, matched by mint", async () => {
    const calls: { url: URL; at: number }[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      calls.push({ url, at: Date.now() });
      const mints = url.searchParams.get("query")!.split(",");
      // One real row per mint plus an unrequested look-alike (same symbol, other mint): ignored.
      return Response.json([...mints.map((id) => ({ id, symbol: "X", isVerified: true })), { id: "So11111111111111111111111111111111111111112", symbol: "TSLAx" }]);
    }) as unknown as typeof fetch;
    const rows = await fetchJupiterStockRows({ fetcher });
    expect(calls).toHaveLength(Math.ceil(STOCK_UNIVERSE.length / 100));
    expect(calls).toHaveLength(3);
    for (const call of calls) {
      expect(call.url.pathname).toMatch(/\/tokens\/v2\/search$/);
      expect(call.url.searchParams.get("query")!.split(",").length).toBeLessThanOrEqual(100);
    }
    for (let index = 1; index < calls.length; index++) expect(calls[index]!.at - calls[index - 1]!.at).toBeGreaterThanOrEqual(STOCK_JUPITER_SPACING_MS - 5);
    expect(rows.map((row) => row.id).sort()).toEqual(STOCK_UNIVERSE.map(([mint]) => mint).sort());
  }, 15_000);

  it("throws on a non-array payload (never cached as an empty market)", async () => {
    const fetcher = vi.fn(async () => Response.json({ error: "nope" })) as unknown as typeof fetch;
    await expect(fetchJupiterStockRows({ fetcher })).rejects.toThrow(/unexpected payload/);
  }, 15_000);
});

describe("isStockSourceUnavailable", () => {
  it("treats Jupiter 429 / 5xx and timeouts as outages, a 400 as a per-token refusal", () => {
    expect(isStockSourceUnavailable(new JupiterHttpError(429, "limited", null))).toBe(true);
    expect(isStockSourceUnavailable(new JupiterHttpError(502, "bad gateway", null))).toBe(true);
    expect(isStockSourceUnavailable(Object.assign(new Error("t"), { name: "TimeoutError" }))).toBe(true);
    expect(isStockSourceUnavailable(new JupiterHttpError(400, "bad request", null))).toBe(false);
    expect(isStockSourceUnavailable(new Error("other"))).toBe(false);
  });
});
