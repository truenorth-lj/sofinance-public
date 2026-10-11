import { TickUtil } from "@raydium-io/raydium-sdk-v2";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const readChain = vi.hoisted(() => vi.fn());
vi.mock("./range-apr/onchain-liquidity", () => ({ readOnchainPoolLiquidity: readChain }));

import { clearPoolRangeAprCache, fetchPoolRangeApr, RANGE_APR_ASSUMPTIONS } from "./pool-range-apr";

const POOL = "5MBpNcWTqiWy3pZX17pYfgP2ZxrSkok4naQWLj3XLDLY";
const MINT_A = "XsvNBAYkrDRNhA7wPHQfX3ZUXZyZLdnCQDfHZ56bzpg";
const MINT_B = "HooDYv5RewLRiMLnEVq3VJqdqxhuE6c5eYvqejMC3e9A";
const DAY = 86_400;
const D0 = 1_791_331_200;
const NOW = D0 + 10 * DAY + 3_600;
const TICK = -46_068;

function chainFixture() {
  const bins = [];
  for (let bin = -768 - 6; bin <= -768 + 6; bin++) {
    bins.push({ tick: bin * 60, liquidity: bin >= -771 && bin <= -769 ? 6e10 : 0 });
  }
  return {
    poolId: POOL, mintA: MINT_A, mintB: MINT_B, decimalsA: 8, decimalsB: 6, tickSpacing: 60, tickCurrent: TICK,
    sqrtPriceX64: TickUtil.getSqrtPriceAtTick(TICK).toString(), bins,
  };
}

const ids = {
  success: true,
  data: [{
    mintA: { address: MINT_A, decimals: 8 }, mintB: { address: MINT_B, decimals: 6 }, feeRate: 0.0025, tvl: 6000, price: 0.9966,
    mintAmountA: 3000, mintAmountB: 3000, config: { protocolFeeRate: 120000, fundFeeRate: 40000 },
    day: { feeApr: 12.1 }, week: { feeApr: 7.5, volume: 7000 },
  }],
};

const daily = { data: { attributes: { ohlcv_list: [1, 2, 3, 4, 5, 6, 7].map((offset) => [D0 + (10 - offset) * DAY, 1, 1, 1, 1, 1000]) } } };
const hourlyRows = [1, 2, 3, 4, 5, 6, 7].flatMap((offset) => [3, 9, 15].map((hour) => {
  const price = 0.9966 * (1 + (hour - 9) * 0.0003);
  return [D0 + (10 - offset) * DAY + hour * 3_600, price, price * 1.0004, price * 0.9996, price, 10];
}));
const hourly = {
  data: { attributes: { ohlcv_list: hourlyRows } },
  meta: { base: { address: MINT_A }, quote: { address: MINT_B } },
};

function fetcher(options: { daily?: unknown; hourly?: unknown; ids?: unknown; hourlyOk?: boolean } = {}) {
  const calls: string[] = [];
  const impl: typeof fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    if (url.includes("/pools/info/ids")) return json(options.ids ?? ids, options.ids === null ? 503 : 200);
    if (url.includes("/ohlcv/day")) return json(options.daily ?? daily, options.daily === null ? 429 : 200);
    if (url.includes("/ohlcv/hour")) return json(options.hourly ?? hourly, options.hourlyOk === false ? 429 : 200);
    return json({}, 404);
  };
  return { impl, calls };
}

beforeEach(() => readChain.mockResolvedValue(chainFixture()));
afterEach(() => {
  clearPoolRangeAprCache();
  readChain.mockReset();
});

describe("fetchPoolRangeApr", () => {
  it("returns every preset priced, the AI pick first, with the chosen method described", async () => {
    const { impl } = fetcher();
    const payload = await fetchPoolRangeApr(POOL, { fetcher: impl, nowSeconds: NOW, bypassCache: true });
    expect(payload.poolId).toBe(POOL);
    expect(payload.label).toBe("Est. fee APR");
    expect(payload.assumptions).toBe(RANGE_APR_ASSUMPTIONS);
    expect(payload.presets.map((preset) => preset.id)).toEqual(["ai", "tight", "standard", "wide"]);
    const ai = payload.presets[0]!;
    expect([ai.tickLower, ai.tickUpper]).toEqual([-46_200, -45_960]);
    expect(ai.priceLower).toBeLessThan(payload.pool.currentPrice * 1.05);
    for (const preset of payload.presets) expect(preset.estimate.status).toBe("ok");
    expect(payload.pool).toMatchObject({ tickSpacing: 60, tickCurrent: TICK, feeRate: 0.0025, tvlUsd: 6000 });
    expect(payload.pool.lpFeeFraction).toBeCloseTo(0.84, 12);
    expect(payload.model.avgDailyVolumeUsd).toBe(1000);
    expect(payload.model.bins).toHaveLength(13);
    expect(payload.sample).toMatchObject({ days: 7, volumeSource: "geckoterminal-daily", occupancySource: "hourly-candles", candleCount: 21 });
    expect(payload.referenceCapitalUsd).toBe(100);
    expect(payload.published).toEqual({ dayFeeApr: 12.1, weekFeeApr: 7.5 });
    expect(payload.sources.length).toBeGreaterThanOrEqual(4);
  });

  it("is JSON serialisable (it is the API response)", async () => {
    const payload = await fetchPoolRangeApr(POOL, { fetcher: fetcher().impl, nowSeconds: NOW, bypassCache: true });
    expect(JSON.parse(JSON.stringify(payload))).toEqual(payload);
  });

  it("gives volume only to bins with liquidity and conserves it", async () => {
    const payload = await fetchPoolRangeApr(POOL, { fetcher: fetcher().impl, nowSeconds: NOW, bypassCache: true });
    const placed = payload.model.bins.reduce((sum, bin) => sum + bin.volumeUsd, 0);
    expect(placed).toBeCloseTo(1000 * (1 - payload.sample.unplacedVolumePct / 100), 6);
    for (const bin of payload.model.bins) if (bin.liquidity === 0) expect(bin.volumeUsd).toBe(0);
  });

  it("falls back to Raydium 7d volume and the current price when GeckoTerminal fails, and says so", async () => {
    const { impl } = fetcher({ daily: null, hourlyOk: false });
    const payload = await fetchPoolRangeApr(POOL, { fetcher: impl, nowSeconds: NOW, bypassCache: true });
    expect(payload.sample).toMatchObject({ volumeSource: "raydium-7d", occupancySource: "current-price", candleCount: 0, confidence: "low" });
    expect(payload.model.avgDailyVolumeUsd).toBeCloseTo(1000, 9); // 7000 / 7
    expect(payload.presets[0]!.estimate.status).toBe("ok");
  });

  it("fails clearly when Raydium pool economics are unavailable", async () => {
    await expect(fetchPoolRangeApr(POOL, { fetcher: fetcher({ ids: null }).impl, nowSeconds: NOW, bypassCache: true }))
      .rejects.toThrow(/economics unavailable/i);
  });

  it("fails clearly when no volume source exists or TVL is zero", async () => {
    const noWeek = { ...ids, data: [{ ...ids.data[0], week: {} }] };
    await expect(fetchPoolRangeApr(POOL, { fetcher: fetcher({ ids: noWeek, daily: null }).impl, nowSeconds: NOW, bypassCache: true }))
      .rejects.toThrow(/volume unavailable/i);
    const noTvl = { ...ids, data: [{ ...ids.data[0], tvl: 0 }] };
    await expect(fetchPoolRangeApr(POOL, { fetcher: fetcher({ ids: noTvl }).impl, nowSeconds: NOW, bypassCache: true }))
      .rejects.toThrow(/TVL unavailable/i);
  });

  it("caches per pool and de-duplicates concurrent callers (one upstream round trip)", async () => {
    const { impl, calls } = fetcher();
    const [first, second] = await Promise.all([
      fetchPoolRangeApr(POOL, { fetcher: impl, nowSeconds: NOW }),
      fetchPoolRangeApr(POOL, { fetcher: impl, nowSeconds: NOW }),
    ]);
    expect(first).toEqual(second);
    await fetchPoolRangeApr(POOL, { fetcher: impl, nowSeconds: NOW });
    expect(calls).toHaveLength(3); // ids + day + hour, once
    expect(readChain).toHaveBeenCalledTimes(1);
  });

  it("does not retry a failing upstream on every call (short negative cache)", async () => {
    const { impl, calls } = fetcher({ ids: null });
    await expect(fetchPoolRangeApr(POOL, { fetcher: impl, nowSeconds: NOW })).rejects.toThrow();
    const before = calls.length;
    await expect(fetchPoolRangeApr(POOL, { fetcher: impl, nowSeconds: NOW })).rejects.toThrow();
    expect(calls.length).toBe(before);
  });
});
