import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { clearPoolDailyAprCache, fetchPoolDailyApr, getCachedPoolDailyApr } from "./pool-daily-apr";

const POOL = "Pool1111111111111111111111111111111111111";
const D1 = 1_791_331_200;
const D2 = 1_791_417_600;
const D3 = 1_791_504_000;

afterEach(() => {
  clearPoolDailyAprCache();
});

function jsonResponse(body: unknown, ok = true) {
  return new Response(JSON.stringify(body), {
    status: ok ? 200 : 503,
    headers: { "Content-Type": "application/json" },
  });
}

describe("fetchPoolDailyApr", () => {
  it("joins mocked Raydium + GeckoTerminal payloads into a labeled daily series", async () => {
    const fetcher: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes("/pools/info/ids")) {
        return jsonResponse({
          success: true,
          data: [
            {
              feeRate: 0.0001,
              tvl: 200_000,
              day: { volume: 80_000, volumeFee: 8, feeApr: 1.46 },
              week: { feeApr: 1.1 },
              month: { feeApr: 0.9 },
            },
          ],
        });
      }
      if (url.includes("/pools/line/liquidity")) {
        return jsonResponse({
          success: true,
          data: {
            line: [
              { time: D1, liquidity: 180_000 },
              { time: D2, liquidity: 190_000 },
              { time: D3, liquidity: 200_000 },
            ],
          },
        });
      }
      if (url.includes("geckoterminal.com")) {
        return jsonResponse({
          data: {
            attributes: {
              ohlcv_list: [
                [D1, 1, 1, 1, 1, 50_000],
                [D2, 1, 1, 1, 1, 60_000],
              ],
            },
          },
        });
      }
      throw new Error(`unexpected url ${url}`);
    };

    const result = await fetchPoolDailyApr(POOL, { fetcher, nowSeconds: D3, bypassCache: true });
    expect(result.label).toBe("Pool fee APR (daily, estimated)");
    expect(result.assumptions).toMatch(/not Raydium-published daily feeApr/i);
    expect(result.published.dayFeeApr).toBeCloseTo(1.46);
    expect(result.sources.some((s) => s.includes("pools/line/liquidity"))).toBe(true);
    expect(result.sources.some((s) => s.includes("geckoterminal"))).toBe(true);
    const byDate = Object.fromEntries(result.points.map((p) => [p.date, p]));
    expect(byDate["2026-10-07"]?.aprPct).toBeCloseTo((50_000 * 0.0001 / 180_000) * 365 * 100, 6);
    expect(byDate["2026-10-08"]?.aprPct).toBeCloseTo((60_000 * 0.0001 / 190_000) * 365 * 100, 6);
    // Today: Raydium day.volume fallback + TVL line
    expect(byDate["2026-10-09"]?.aprPct).toBeCloseTo((80_000 * 0.0001 / 200_000) * 365 * 100, 6);
  });

  it("still returns a series when GeckoTerminal is down, using Raydium day volume for today only", async () => {
    const fetcher: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes("/pools/info/ids")) {
        return jsonResponse({
          success: true,
          data: [{ feeRate: 0.001, tvl: 10_000, day: { volume: 100, feeApr: 3.65 } }],
        });
      }
      if (url.includes("/pools/line/liquidity")) {
        return jsonResponse({ success: true, data: { line: [{ time: D3, liquidity: 10_000 }] } });
      }
      if (url.includes("geckoterminal.com")) {
        return jsonResponse({ error: "nope" }, false);
      }
      throw new Error(`unexpected url ${url}`);
    };

    const result = await fetchPoolDailyApr(POOL, { fetcher, nowSeconds: D3, bypassCache: true });
    expect(result.points).toHaveLength(1);
    expect(result.points[0]?.aprPct).toBeCloseTo(0.365, 6);
    expect(result.sources.some((s) => s.includes("geckoterminal"))).toBe(false);
  });

  it("serves the in-memory cache on a second call", async () => {
    let calls = 0;
    const fetcher: typeof fetch = async () => {
      calls += 1;
      return jsonResponse({
        success: true,
        data: [{ feeRate: 0.001, tvl: 1, day: { volume: 0, feeApr: 0 } }],
      });
    };
    await fetchPoolDailyApr(POOL, { fetcher, nowSeconds: D3 });
    const cached = getCachedPoolDailyApr(POOL);
    expect(cached?.cacheHit).toBe(true);
    expect(cached?.poolId).toBe(POOL);
    expect(calls).toBe(3);
  });
});
