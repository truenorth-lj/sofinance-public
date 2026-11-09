import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ unstable_cache: <T,>(fn: T) => fn }));
const spotSwapRouteCheck = vi.fn();
vi.mock("@sofinance/engine/spot-swap", async (importOriginal) => ({
  ...await importOriginal<typeof import("@sofinance/engine/spot-swap")>(),
  spotSwapRouteCheck: (...args: unknown[]) => spotSwapRouteCheck(...args),
}));

import { cachedRouteCheck, fetchJupiterStockRows, isStockSourceUnavailable, loadStockMarket, STOCK_JUPITER_SPACING_MS } from "./source";
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

  it("keeps every call 1.1 s apart when two refreshes run at the same time (one queue, not a shared timestamp)", async () => {
    const starts: number[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      starts.push(Date.now());
      return Response.json(new URL(String(input)).searchParams.get("query")!.split(",").map((id) => ({ id, symbol: "X" })));
    }) as unknown as typeof fetch;
    await Promise.all([fetchJupiterStockRows({ fetcher }), fetchJupiterStockRows({ fetcher })]);
    expect(starts).toHaveLength(6);
    for (let index = 1; index < starts.length; index++) expect(starts[index]! - starts[index - 1]!).toBeGreaterThanOrEqual(STOCK_JUPITER_SPACING_MS - 5);
  }, 20_000);

  it("throws on a non-array payload (never cached as an empty market)", async () => {
    const fetcher = vi.fn(async () => Response.json({ error: "nope" })) as unknown as typeof fetch;
    await expect(fetchJupiterStockRows({ fetcher })).rejects.toThrow(/unexpected payload/);
  }, 15_000);
});

describe("in-flight sharing", () => {
  it("two market cache misses at once share one refresh (3 calls, not 6); a failed refresh is not kept", async () => {
    // Rows that pass no filter: the refresh fails ("No stock passed the filters"), which must not be cached.
    const fetchMock = vi.fn(async (input: RequestInfo | URL) =>
      Response.json(new URL(String(input)).searchParams.get("query")!.split(",").map((id) => ({ id, symbol: "X" }))));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const results = await Promise.allSettled([loadStockMarket(), loadStockMarket()]);
      expect(results.map((result) => result.status)).toEqual(["rejected", "rejected"]);
      expect(fetchMock).toHaveBeenCalledTimes(3);
      await expect(loadStockMarket()).rejects.toThrow(/No stock passed/);
      expect(fetchMock).toHaveBeenCalledTimes(6);
    } finally { vi.unstubAllGlobals(); }
  }, 20_000);

  it("two route probes of the same mint and amount at once make one Jupiter quote", async () => {
    spotSwapRouteCheck.mockReset().mockImplementation(async () => "ok");
    const mint = STOCK_UNIVERSE[0]![0];
    expect(await Promise.all([cachedRouteCheck(mint, 7_000_000n), cachedRouteCheck(mint, 7_000_000n)])).toEqual(["ok", "ok"]);
    expect(spotSwapRouteCheck).toHaveBeenCalledTimes(1);
  }, 10_000);
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
