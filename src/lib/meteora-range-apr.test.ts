import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import fixture from "../../packages/engine/src/fixtures/meteora-dlmm-pool-cbbtc-wbtc.json";
import { clearMeteoraRangeAprCache, dedupePresetsByWidth, fetchMeteoraRangeApr, METEORA_RANGE_APR_ASSUMPTIONS, METEORA_RANGE_APR_LABEL, meteoraPresetRanges, presetBins } from "./meteora-range-apr";
import { clearPoolRangeAprCache } from "./pool-range-apr";
import { METEORA_POOL, fakeMeteoraConnection, meteoraAccounts } from "./range-apr/meteora-chain.fixture";
import { meteoraDatapiHistory, MeteoraDatapiError } from "./range-apr/meteora-datapi-history";
import { binTick, binTickSqrtPriceX64 } from "./range-apr/meteora-liquidity";
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
    expect(payload.assumptions).toMatch(/^Estimate, not a prediction/);
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

describe("Meteora presets by bin step (bin grid, deduplicated by width)", () => {
  const table = (binStep: number, activeId = 16, decimalsA = 8, decimalsB = 8) => {
    const chain = { tickCurrent: binTick(activeId, binStep), sqrtPriceX64: binTickSqrtPriceX64(activeId, binStep), decimalsA, decimalsB, tickSpacing: binStep };
    return Object.fromEntries(presetBins(meteoraPresetRanges(chain), null, binStep).map((p) => [p.id, [p.lowerBinId - activeId, p.upperBinId - activeId]]));
  };

  it("bin step 1 keeps the four shared presets (unchanged)", () => {
    expect(table(1)).toEqual({ micro: [-2, 1], tight: [-6, 3], standard: [-31, 28], wide: [-101, 98] });
  });

  it("bin steps 2 / 5 / 10 price the same percent ranges in whole bins and drop a preset narrower than Micro", () => {
    expect(table(2)).toEqual({ micro: [-2, 1], tight: [-3, 1], standard: [-16, 14], wide: [-51, 49] });
    expect(table(5)).toEqual({ micro: [-2, 1], standard: [-7, 5], wide: [-21, 19] });
    expect(table(10)).toEqual({ micro: [-2, 1], standard: [-4, 2], wide: [-11, 9] });
  });

  it("does not depend on where the active bin is or on the token decimals (anchored mapping)", () => {
    for (const binStep of [1, 2, 5, 10]) {
      expect(table(binStep, -6911, 8, 6)).toEqual(table(binStep));
      expect(table(binStep, 2500, 6, 9)).toEqual(table(binStep));
    }
  });

  it("dedupes by width: an equal width keeps the wider id, a narrower one is dropped", () => {
    const range = (id: "micro" | "tight" | "standard" | "wide", width: number) => ({ id, tickLower: -width, tickUpper: width });
    expect(dedupePresetsByWidth([range("wide", 9), range("micro", 2), range("tight", 2), range("standard", 1)]).map((p) => p.id))
      .toEqual(["tight", "wide"]);
    expect(dedupePresetsByWidth([range("micro", 2), range("tight", 3), range("standard", 4), range("wide", 5)])).toHaveLength(4);
  });

  it("presetBins converts tick bounds back to bins for bin step > 1", () => {
    expect(presetBins([{ id: "standard", tickLower: 120, tickUpper: 230 }], { lowerBinId: -70, upperBinId: 69 }, 10)).toEqual([
      { id: "standard", lowerBinId: 12, upperBinId: 22, binCount: 11, binArrayIndexes: [0], withinExistingBinArrays: true },
    ]);
  });
});

describe("fetchMeteoraRangeApr for a scan-found pool (spec + Meteora datapi history)", () => {
  const D0 = 1_793_145_600 - 0; // 2026-10-28T00:00Z is the open day
  const binStep = 10;
  const spec = { poolAddress: METEORA_POOL, mintX: CBBTC, mintY: WBTC, binStep };
  // The on-chain base fee scales with the bin step (base factor × bin step): 0.1% here.
  const datapiPool = { ...fixture, pool_config: { ...fixture.pool_config, bin_step: binStep, base_fee_pct: 0.1 } };
  const connection = () => {
    const data = Buffer.from(meteoraAccounts()[METEORA_POOL]!.data, "base64");
    data.writeUInt16LE(binStep, 80);
    return fakeMeteoraConnection(meteoraAccounts({ [METEORA_POOL]: { ...meteoraAccounts()[METEORA_POOL]!, data: data.toString("base64") } })).connection;
  };
  const datapi = (status: { volume?: number } = {}) => {
    const calls: string[] = [];
    const impl: typeof fetch = async (input) => {
      const url = new URL(String(input));
      calls.push(url.toString());
      const json = (body: unknown, code = 200) => new Response(JSON.stringify(body), { status: code, headers: { "Content-Type": "application/json" } });
      if (url.pathname === `/pools/${METEORA_POOL}`) return json(datapiPool);
      if (url.pathname.endsWith("/volume/history")) {
        return json({ data: [1, 2, 3, 4, 5, 6, 7].map((back) => ({ timestamp: D0 - back * DAY, volume: 40_000, fees: 40, protocol_fees: 4 })) }, status.volume ?? 200);
      }
      if (url.pathname.endsWith("/ohlcv")) {
        const start = Number(url.searchParams.get("start_time")), end = Number(url.searchParams.get("end_time"));
        const data = [];
        for (let time = start; time < end; time += 6 * 3_600) {
          const price = 1.0016 * (1 + ((time / 3_600) % 24 - 11) * 0.00002);
          data.push({ timestamp: time, open: price, high: price * 1.00005, low: price * 0.99995, close: price, volume: 1_000 });
        }
        return json({ data });
      }
      return json({}, 404);
    };
    return { impl, calls };
  };
  const runSpec = (f = datapi()) => fetchMeteoraRangeApr(METEORA_POOL, {
    fetcher: f.impl, connection: connection(), nowSeconds: NOW, retry: NO_WAIT, gate: gate(), spec,
    history: meteoraDatapiHistory({ mintX: CBBTC, mintY: WBTC }),
  });

  it("prices bin step 10 with datapi volume and candles only (no GeckoTerminal call)", async () => {
    const f = datapi();
    const payload = await runSpec(f);
    expect(f.calls.every((url) => url.startsWith("https://dlmm.datapi.meteora.ag/"))).toBe(true);
    expect(f.calls.filter((url) => url.includes("/ohlcv"))).toHaveLength(2);
    expect(payload).toMatchObject({
      pool: { tickSpacing: 10, tickCurrent: 160 },
      sample: { days: 7, volumeSource: "meteora-datapi-daily", occupancySource: "hourly-candles", degraded: false, confidence: "ok" },
      state: { binStep: 10, activeId: 16 },
    });
    expect(payload.model.avgDailyVolumeUsd).toBe(40_000);
    expect(payload.assumptions).toMatch(/\(Meteora, current day excluded\)/);
    expect(payload.presets.map((preset) => preset.id)).toEqual(["micro", "standard", "wide"]);
    expect(payload.presets.every((preset) => preset.estimate.status === "ok")).toBe(true);
    expect(payload.presetBins.map((bins) => [bins.id, bins.lowerBinId, bins.upperBinId])).toEqual([
      ["micro", 14, 17], ["standard", 12, 18], ["wide", 5, 25]]);
    expect(payload.sources.join(" ")).toMatch(/volume\/history/);
    expect(payload.sources.join(" ")).not.toMatch(/geckoterminal/i);
    // datapi fees match the on-chain config (0.1%, 10% protocol); only the datapi 5% vs on-chain 10% note.
    expect(payload.dataNotes).toEqual(["protocol share: datapi 5%, on-chain 10%"]);
  });

  it("notes datapi fees that disagree with the on-chain config", async () => {
    const f = datapi();
    const impl: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      if (!url.pathname.endsWith("/volume/history")) return f.impl(input, init);
      return new Response(JSON.stringify({ data: [1, 2, 3, 4, 5, 6, 7].map((back) => ({ timestamp: D0 - back * DAY, volume: 40_000, fees: 2, protocol_fees: 1 })) }), { status: 200 });
    };
    const payload = await runSpec({ impl, calls: f.calls });
    expect(payload.dataNotes.slice(1)).toEqual([
      "datapi 7d fees 0.0050% of volume, below the 0.1000% on-chain base fee",
      "datapi 7d protocol fees 50.0% of fees, on-chain share 10.0%",
    ]);
  });

  it("fails the pool on a datapi 429 (the cron skips it; no retry, no fallback)", async () => {
    const f = datapi({ volume: 429 });
    await expect(runSpec(f)).rejects.toBeInstanceOf(MeteoraDatapiError);
    expect(f.calls.filter((url) => url.includes("/volume/history"))).toHaveLength(1);
  });

  it("refuses a spec for another pool, and an unlisted bin step in the datapi body", async () => {
    await expect(fetchMeteoraRangeApr("8k2c9Kiavx5pbWc2dmzhL7vFp11sLgMcKFfSueq8haAh", { spec })).rejects.toThrow(/allowlisted/);
    expect(parseMeteoraPoolEconomics(fixture, spec)).toBeNull(); // datapi says bin step 1
    expect(parseMeteoraPoolEconomics(datapiPool, spec)).toMatchObject({ mintA: CBBTC, mintB: WBTC });
  });
});
