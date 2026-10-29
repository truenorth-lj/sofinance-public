import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import fixture from "../../packages/engine/src/fixtures/orca-pool-cbbtc-wbtc.json";
import { clearOrcaRangeAprCache, fetchOrcaRangeApr, ORCA_RANGE_APR_ASSUMPTIONS } from "./orca-range-apr";
import { clearPoolRangeAprCache } from "./pool-range-apr";
import { ORCA_POOL, fakeOrcaConnection } from "./range-apr/orca-chain.fixture";
import { ThrottleGate } from "./range-apr/throttle-gate";

const CBBTC = "cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij";
const WBTC = "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh";
const DAY = 86_400;
const D0 = 1_793_145_600; // 2026-10-28T00:00Z
const NOW = D0 + 5 * 3_600;
const NO_WAIT = { sleep: async (ms: number) => { void ms; } };
const gate = () => new ThrottleGate({ minSpacingMs: 0, sleep: async (ms: number) => { void ms; } });

const daily = { data: { attributes: { ohlcv_list: [1, 2, 3, 4, 5, 6, 7].map((offset) => [D0 - offset * DAY, 1, 1, 1, 1, 1_500_000]) } } };
const hourly = {
  data: { attributes: { ohlcv_list: [1, 2, 3, 4, 5, 6, 7].flatMap((offset) => [2, 8, 14, 20].map((hour) => {
    const price = 1.0016 * (1 + (hour - 11) * 0.00002);
    return [D0 - offset * DAY + hour * 3_600, price, price * 1.00005, price * 0.99995, price, 10];
  })) } },
  meta: { base: { address: CBBTC }, quote: { address: WBTC } },
};

function fetcher(options: { orca?: number; hourly?: number } = {}) {
  const calls: string[] = [];
  const impl: typeof fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    if (url.startsWith(`https://api.orca.so/v2/solana/pools/${ORCA_POOL}`)) return json(fixture, options.orca ?? 200);
    if (url.includes("/ohlcv/day")) return json(daily);
    if (url.includes("/ohlcv/hour")) return json(hourly, options.hourly ?? 200);
    return json({}, 404);
  };
  return { impl, calls };
}

const run = (f = fetcher(), connection = fakeOrcaConnection().connection) =>
  fetchOrcaRangeApr(ORCA_POOL, { fetcher: f.impl, connection, nowSeconds: NOW, bypassCache: true, retry: NO_WAIT, gate: gate() });

// clearPoolRangeAprCache also drops the shared stale-if-error price history.
afterEach(() => { clearOrcaRangeAprCache(); clearPoolRangeAprCache(); });

describe("fetchOrcaRangeApr (read-only, cbBTC/WBTC)", () => {
  it("returns the shared range-APR payload with Orca economics, state and liquidity", async () => {
    const f = fetcher();
    const payload = await run(f);
    expect(payload).toMatchObject({
      poolId: ORCA_POOL, protocol: "orca-whirlpool", readOnly: true, assumptions: ORCA_RANGE_APR_ASSUMPTIONS,
      pool: { tickSpacing: 1, tickCurrent: 16, decimalsA: 8, decimalsB: 8, feeRate: 0.0001 },
      sample: { days: 7, volumeSource: "geckoterminal-daily", occupancySource: "hourly-candles", degraded: false },
      state: { feeRate: 100, protocolFeeRate: 1300, mintA: CBBTC, mintB: WBTC, sqrtPriceX64: "18461595609128926554" },
    });
    expect(payload.pool.lpFeeFraction).toBeCloseTo(0.87, 12);
    expect(payload.model.bins).toHaveLength(601);
    expect(payload.model.avgDailyVolumeUsd).toBe(1_500_000);
    expect(payload.presets.map((preset) => preset.id)).toEqual(["micro", "tight", "standard", "wide"]);
    for (const preset of payload.presets) {
      expect(preset.tickLower).toBeLessThanOrEqual(16);
      expect(preset.tickUpper).toBeGreaterThan(16);
      expect(preset.estimate.status).toBe("ok");
    }
    expect(payload.sources.at(-1)).toMatch(/Whirlpool account \+ tick arrays/);
    expect(payload.sources[0]).toMatch(/api\.orca\.so/);
    expect(payload.assumptions).not.toMatch(/Raydium/);
    expect(payload.published.dayFeeApr).toBeGreaterThan(0);
    // Never touches Raydium's API.
    expect(f.calls.some((url) => url.includes("raydium"))).toBe(false);
    expect(JSON.parse(JSON.stringify(payload))).toEqual(payload);
  });

  it("is degraded (no estimates) when hourly price history is missing", async () => {
    const payload = await run(fetcher({ hourly: 429 }));
    expect(payload.sample.degraded).toBe(true);
    expect(payload.presets.every((preset) => preset.estimate.status === "unavailable")).toBe(true);
  });

  it("fails clearly when Orca economics are unavailable", async () => {
    await expect(run(fetcher({ orca: 404 }))).rejects.toThrow(/Pool economics unavailable from Orca/);
  });

  it("refuses non-allowlisted pools without any upstream call", async () => {
    const f = fetcher();
    await expect(fetchOrcaRangeApr("5MBpNcWTqiWy3pZX17pYfgP2ZxrSkok4naQWLj3XLDLY", { fetcher: f.impl })).rejects.toThrow(/allowlisted/);
    expect(f.calls).toHaveLength(0);
  });
});
