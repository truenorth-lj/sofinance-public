import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import fixture from "../../packages/engine/src/fixtures/meteora-dlmm-pool-cbbtc-wbtc.json";
import { clearMeteoraRangeAprCache, fetchMeteoraRangeApr, METEORA_RANGE_APR_ASSUMPTIONS, METEORA_RANGE_APR_LABEL, presetBins } from "./meteora-range-apr";
import { clearPoolRangeAprCache } from "./pool-range-apr";
import { METEORA_POOL, fakeMeteoraConnection } from "./range-apr/meteora-chain.fixture";
import { parseMeteoraPoolEconomics } from "./range-apr/meteora-economics";
import { ThrottleGate } from "./range-apr/throttle-gate";

const CBBTC = "cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij";
const WBTC = "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh";
const DAY = 86_400;
const D0 = 1_793_145_600; // 2026-10-28T00:00Z
const NOW = D0 + 5 * 3_600;
const NO_WAIT = { sleep: async (ms: number) => { void ms; } };
const gate = () => new ThrottleGate({ minSpacingMs: 0, sleep: async (ms: number) => { void ms; } });

const daily = { data: { attributes: { ohlcv_list: [1, 2, 3, 4, 5, 6, 7].map((offset) => [D0 - offset * DAY, 1, 1, 1, 1, 40_000]) } } };
const hourly = {
  data: { attributes: { ohlcv_list: [1, 2, 3, 4, 5, 6, 7].flatMap((offset) => [2, 8, 14, 20].map((hour) => {
    const price = 1.0016 * (1 + (hour - 11) * 0.00002);
    return [D0 - offset * DAY + hour * 3_600, price, price * 1.00005, price * 0.99995, price, 10];
  })) } },
  meta: { base: { address: CBBTC }, quote: { address: WBTC } },
};

function fetcher(options: { meteora?: number; hourly?: number; daily?: number } = {}) {
  const calls: string[] = [];
  const impl: typeof fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    if (url === `https://dlmm.datapi.meteora.ag/pools/${METEORA_POOL}`) return json(fixture, options.meteora ?? 200);
    if (url.includes("/ohlcv/day")) return json(daily, options.daily ?? 200);
    if (url.includes("/ohlcv/hour")) return json(hourly, options.hourly ?? 200);
    return json({}, 404);
  };
  return { impl, calls };
}

const run = (f = fetcher(), connection = fakeMeteoraConnection().connection) =>
  fetchMeteoraRangeApr(METEORA_POOL, { fetcher: f.impl, connection, nowSeconds: NOW, bypassCache: true, retry: NO_WAIT, gate: gate() });

afterEach(() => { clearMeteoraRangeAprCache(); clearPoolRangeAprCache(); });

describe("parseMeteoraPoolEconomics", () => {
  it("maps the datapi pool (X → A, Y → B)", () => {
    expect(parseMeteoraPoolEconomics(fixture)).toMatchObject({
      mintA: CBBTC, mintB: WBTC, decimalsA: 8, decimalsB: 8, feeRate: 0.0001, protocolFeeRate: 50_000, fundFeeRate: 0,
      mintAmountA: 2.18049319, mintAmountB: 1.95571161, weekVolumeUsd: null, weekFeeApr: null,
    });
    expect(parseMeteoraPoolEconomics(fixture)!.dayFeeApr).toBeCloseTo((4.247998606572472 / 336203.47025545826) * 365 * 100, 9);
  });

  it("rejects blacklisted, non-allowlisted or incomplete pools", () => {
    expect(parseMeteoraPoolEconomics({ ...fixture, is_blacklisted: true })).toBeNull();
    expect(parseMeteoraPoolEconomics({ ...fixture, address: "8k2c9Kiavx5pbWc2dmzhL7vFp11sLgMcKFfSueq8haAh" })).toBeNull();
    expect(parseMeteoraPoolEconomics({ ...fixture, token_x_amount: null })).toBeNull();
    expect(parseMeteoraPoolEconomics({ ...fixture, current_price: 0 })).toBeNull();
    expect(parseMeteoraPoolEconomics(null)).toBeNull();
  });
});

describe("fetchMeteoraRangeApr (read-only, cbBTC/WBTC)", () => {
  it("returns the shared payload, labelled estimated, with on-chain fees, state and bin-array liquidity", async () => {
    const f = fetcher();
    const payload = await run(f);
    expect(payload).toMatchObject({
      poolId: METEORA_POOL, protocol: "meteora-dlmm", readOnly: true, estimated: true,
      label: METEORA_RANGE_APR_LABEL, assumptions: METEORA_RANGE_APR_ASSUMPTIONS,
      pool: { tickSpacing: 1, tickCurrent: 16, decimalsA: 8, decimalsB: 8, feeRate: 0.0001 },
      sample: { days: 7, volumeSource: "geckoterminal-daily", occupancySource: "hourly-candles", degraded: false },
      state: { binStep: 1, activeId: 16, baseFeeRate: 100_000, protocolShare: 1000, mintX: CBBTC, mintY: WBTC,
        freezeAuthorityX: true, freezeAuthorityY: false, existingBinRange: { lowerBinId: -210, upperBinId: 349 } },
    });
    expect(payload.label).toMatch(/^Estimated/);
    expect(payload.assumptions).toMatch(/^Estimate, not a guarantee/);
    // On-chain protocol share (10%) wins over datapi's 5%.
    expect(payload.pool.lpFeeFraction).toBeCloseTo(0.9, 12);
    expect(payload.dataNotes).toEqual(["protocol share: datapi 5%, on-chain 10%"]);
    expect(payload.model.bins).toHaveLength(601);
    expect(payload.model.avgDailyVolumeUsd).toBe(40_000);
    expect(payload.presets.map((preset) => preset.id)).toEqual(["micro", "tight", "standard", "wide"]);
    for (const preset of payload.presets) {
      expect(preset.tickLower).toBeLessThanOrEqual(16);
      expect(preset.tickUpper).toBeGreaterThan(16);
      expect(preset.estimate.status).toBe("ok");
    }
    expect(payload.presetBins.map((bins) => bins.id)).toEqual(["micro", "tight", "standard", "wide"]);
    for (const [index, bins] of payload.presetBins.entries()) {
      expect(bins.lowerBinId).toBe(payload.presets[index]!.tickLower);
      expect(bins.upperBinId).toBe(payload.presets[index]!.tickUpper - 1);
    }
    expect({ presets: payload.presets, presetBins: payload.presetBins }).toMatchSnapshot();
    expect(payload.sources[0]).toMatch(/dlmm\.datapi\.meteora\.ag/);
    expect(payload.sources.at(-1)).toMatch(/LbPair \+ bin arrays/);
    expect(payload.assumptions).not.toMatch(/Raydium|Orca/);
    expect(payload.published.dayFeeApr).toBeGreaterThan(0);
    // Only GETs to Meteora and GeckoTerminal; never Raydium or Orca.
    expect(f.calls.every((url) => url.startsWith("https://dlmm.datapi.meteora.ag/") || url.includes("geckoterminal"))).toBe(true);
    expect(JSON.parse(JSON.stringify(payload))).toEqual(payload);
  });

  it("is degraded (no estimates) when hourly price history is missing", async () => {
    const payload = await run(fetcher({ hourly: 429 }));
    expect(payload.sample.degraded).toBe(true);
    expect(payload.presets.every((preset) => preset.estimate.status === "unavailable")).toBe(true);
  });

  it("fails when Meteora economics are unavailable, or without daily volume (datapi has no 7d)", async () => {
    await expect(run(fetcher({ meteora: 503 }))).rejects.toThrow(/economics unavailable from Meteora/);
    await expect(run(fetcher({ daily: 500 }))).rejects.toThrow(/volume unavailable/);
  });

  it("refuses non-allowlisted pools before any request", async () => {
    const f = fetcher();
    const { connection, calls } = fakeMeteoraConnection();
    await expect(fetchMeteoraRangeApr("8k2c9Kiavx5pbWc2dmzhL7vFp11sLgMcKFfSueq8haAh", { fetcher: f.impl, connection })).rejects.toThrow(/allowlisted/);
    expect(f.calls).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });
});

describe("presetBins", () => {
  it("flags ranges that would need a bin array that does not exist yet", () => {
    const existing = { lowerBinId: -210, upperBinId: 349 };
    expect(presetBins([{ id: "tight", tickLower: -10, tickUpper: 40 }], existing)).toEqual([
      { id: "tight", lowerBinId: -10, upperBinId: 39, binCount: 50, binArrayIndexes: [-1, 0], withinExistingBinArrays: true },
    ]);
    expect(presetBins([{ id: "wide", tickLower: -211, tickUpper: 40 }], existing)[0]!.withinExistingBinArrays).toBe(false);
    expect(presetBins([{ id: "wide", tickLower: 0, tickUpper: 351 }], existing)[0]!.withinExistingBinArrays).toBe(false);
    expect(presetBins([{ id: "micro", tickLower: 15, tickUpper: 17 }], null)[0]!.withinExistingBinArrays).toBe(false);
  });
});
