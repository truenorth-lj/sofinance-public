import { TickUtil } from "@raydium-io/raydium-sdk-v2";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const readChain = vi.hoisted(() => vi.fn());
vi.mock("./range-apr/onchain-liquidity", () => ({ readOnchainPoolLiquidity: readChain }));

import { clearPoolRangeAprCache, fetchPoolRangeApr, RANGE_APR_ASSUMPTIONS } from "./pool-range-apr";
import { ThrottleGate } from "./range-apr/throttle-gate";
import { createCronGeckoGate } from "./pool-metrics/gecko";

const NO_WAIT = { sleep: async (ms: number) => { void ms; } };
/** A fresh, unspaced gate per call so cooldowns never leak between tests. */
const gate = () => new ThrottleGate({ minSpacingMs: 0, sleep: async (ms: number) => { void ms; } });
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
  it("returns every preset priced, Micro first, with the chosen method described", async () => {
    const { impl } = fetcher();
    const payload = await fetchPoolRangeApr(POOL, { fetcher: impl, nowSeconds: NOW, retry: NO_WAIT, gate: gate(), bypassCache: true });
    expect(payload.poolId).toBe(POOL);
    expect(payload.label).toBe("Est. fee APR");
    expect(payload.assumptions).toBe(RANGE_APR_ASSUMPTIONS);
    expect(payload.presets.map((preset) => preset.id)).toEqual(["micro", "tight", "standard", "wide"]);
    const micro = payload.presets[0]!;
    expect([micro.tickLower, micro.tickUpper]).toEqual([-46_200, -45_960]);
    expect(micro.priceLower).toBeLessThan(payload.pool.currentPrice * 1.05);
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
    const payload = await fetchPoolRangeApr(POOL, { fetcher: fetcher().impl, nowSeconds: NOW, retry: NO_WAIT, gate: gate(), bypassCache: true });
    expect(JSON.parse(JSON.stringify(payload))).toEqual(payload);
  });

  it("gives volume only to bins with liquidity and conserves it", async () => {
    const payload = await fetchPoolRangeApr(POOL, { fetcher: fetcher().impl, nowSeconds: NOW, retry: NO_WAIT, gate: gate(), bypassCache: true });
    const placed = payload.model.bins.reduce((sum, bin) => sum + bin.volumeUsd, 0);
    expect(placed).toBeCloseTo(1000 * (1 - payload.sample.unplacedVolumePct / 100), 6);
    for (const bin of payload.model.bins) if (bin.liquidity === 0) expect(bin.volumeUsd).toBe(0);
  });

  it("is degraded, with NO estimates, when price history is missing (never a number from the current price alone)", async () => {
    const { impl } = fetcher({ daily: null, hourlyOk: false });
    const payload = await fetchPoolRangeApr(POOL, { fetcher: impl, nowSeconds: NOW, retry: NO_WAIT, gate: gate(), bypassCache: true });
    expect(payload.sample).toMatchObject({ volumeSource: "protocol-7d", volumeProtocol: "raydium-clmm", occupancySource: "current-price", candleCount: 0, confidence: "low", degraded: true });
    expect(payload.sample.issues).toEqual([
      "GeckoTerminal daily candles: Upstream request failed (429)",
      // the first 429 opened the cooldown, so the second call was not even sent
      "GeckoTerminal hourly candles: throttled (429); cooling down 20s",
    ]);
    expect(payload.model.avgDailyVolumeUsd).toBeCloseTo(1000, 9); // 7000 / 7
    expect(payload.presets).toHaveLength(4);
    for (const preset of payload.presets) {
      expect(preset.estimate).toEqual({ status: "unavailable", reason: "degraded-data" });
      expect(preset.tickUpper).toBeGreaterThan(preset.tickLower); // ranges are still resolved
    }
  });

  it("is degraded when only the hourly candles fail, even though daily volume is fine", async () => {
    const payload = await fetchPoolRangeApr(POOL, { fetcher: fetcher({ hourlyOk: false }).impl, nowSeconds: NOW, retry: NO_WAIT, gate: gate(), bypassCache: true });
    expect(payload.sample).toMatchObject({ volumeSource: "geckoterminal-daily", occupancySource: "current-price", degraded: true });
    expect(payload.presets.every((preset) => preset.estimate.status === "unavailable")).toBe(true);
  });

  it("a healthy fetch is not degraded and reports no issues", async () => {
    const payload = await fetchPoolRangeApr(POOL, { fetcher: fetcher().impl, nowSeconds: NOW, retry: NO_WAIT, gate: gate(), bypassCache: true });
    expect(payload.sample).toMatchObject({ degraded: false, issues: [] });
  });

  it("retries a flaky GeckoTerminal 5xx and recovers full data", async () => {
    let hourCalls = 0;
    const healthy = fetcher().impl;
    const impl: typeof fetch = async (input, init) => {
      if (String(input).includes("/ohlcv/hour") && ++hourCalls <= 1) return new Response("{}", { status: 503 });
      return healthy(input, init);
    };
    const payload = await fetchPoolRangeApr(POOL, { fetcher: impl, nowSeconds: NOW, retry: NO_WAIT, gate: gate(), bypassCache: true });
    expect(hourCalls).toBe(2);
    expect(payload.sample).toMatchObject({ occupancySource: "hourly-candles", degraded: false });
    expect(payload.presets.every((preset) => preset.estimate.status === "ok")).toBe(true);
  });

  it("the cron gate never retries a GeckoTerminal call (a retry would skip its 12 s spacing); Raydium still retries", async () => {
    let hourCalls = 0, idsCalls = 0;
    const healthy = fetcher().impl;
    const impl: typeof fetch = async (input, init) => {
      if (String(input).includes("/ohlcv/hour") && ++hourCalls <= 1) return new Response("{}", { status: 503 });
      if (String(input).includes("/pools/info/ids") && ++idsCalls <= 1) return new Response("{}", { status: 503 });
      return healthy(input, init);
    };
    const cron = createCronGeckoGate({ sleep: async (ms: number) => { void ms; } });
    expect(cron.maxAttempts).toBe(1);
    const payload = await fetchPoolRangeApr(POOL, { fetcher: impl, nowSeconds: NOW, retry: NO_WAIT, gate: cron, bypassCache: true });
    expect(hourCalls).toBe(1);
    expect(idsCalls).toBe(2);
    expect(payload.sample.degraded).toBe(true);
  });

  it("does not retry a 429: it opens the gate's cooldown (Retry-After honoured) and later pools make no GeckoTerminal call", async () => {
    const shared = gate();
    const healthy = fetcher().impl;
    let geckoCalls = 0;
    const throttled: typeof fetch = async (input, init) => {
      if (String(input).includes("geckoterminal")) { geckoCalls++; return new Response("{}", { status: 429, headers: { "Retry-After": "30" } }); }
      return healthy(input, init);
    };
    const first = await fetchPoolRangeApr(POOL, { fetcher: throttled, nowSeconds: NOW, retry: NO_WAIT, gate: shared, bypassCache: true });
    expect(geckoCalls).toBe(1); // the first 429 opened the cooldown; the second call was refused unsent
    expect(first.sample.degraded).toBe(true);
    expect(shared.blockedForMs()).toBeGreaterThan(25_000);
    expect(shared.blockedForMs()).toBeLessThanOrEqual(30_000);
    const { impl, calls } = fetcher();
    const second = await fetchPoolRangeApr("OtherPool111111111111111111111111111111111", { fetcher: impl, nowSeconds: NOW, retry: NO_WAIT, gate: shared, bypassCache: true });
    expect(calls.some((url) => url.includes("geckoterminal"))).toBe(false);
    expect(second.sample.degraded).toBe(true);
    expect(second.sample.issues[0]).toMatch(/throttled \(429\); cooling down \d+s/);
  });

  it("asks the shared Data Cache to keep successful upstream responses (survives cold starts, serves stale on 429)", async () => {
    const seen: Array<{ url: string; revalidate: unknown }> = [];
    const healthy = fetcher().impl;
    const impl: typeof fetch = async (input, init) => {
      seen.push({ url: String(input), revalidate: (init as { next?: { revalidate?: number } } | undefined)?.next?.revalidate });
      return healthy(input, init);
    };
    await fetchPoolRangeApr(POOL, { fetcher: impl, nowSeconds: NOW, retry: NO_WAIT, gate: gate(), bypassCache: true });
    const revalidate = (needle: string) => seen.find((call) => call.url.includes(needle))?.revalidate;
    expect(revalidate("/ohlcv/hour")).toBe(1_800);
    expect(revalidate("/ohlcv/day")).toBe(3_600);
    expect(revalidate("/pools/info/ids")).toBe(300);
  });

  it("thin pool: few, gappy hourly candles still give an estimate (missing hours = no trades), flagged low confidence", async () => {
    const few = {
      ...hourly,
      data: { attributes: { ohlcv_list: [[D0 + 3 * DAY + 5 * 3_600, 0.9966, 0.9968, 0.9964, 0.9966, 4], [D0 + 8 * DAY + 11 * 3_600, 0.9967, 0.9969, 0.9965, 0.9967, 4]] } },
    };
    const payload = await fetchPoolRangeApr(POOL, { fetcher: fetcher({ hourly: few }).impl, nowSeconds: NOW, retry: NO_WAIT, gate: gate(), bypassCache: true });
    expect(payload.sample).toMatchObject({ degraded: false, occupancySource: "hourly-candles", candleCount: 2, confidence: "low" });
    expect(payload.presets.some((preset) => preset.estimate.status === "ok")).toBe(true);
  });

  it("idle pool: no candles but zero volume in the window is an honest 0%, not 'unavailable'", async () => {
    const zeros = { data: { attributes: { ohlcv_list: [1, 2, 3, 4, 5, 6, 7].map((offset) => [D0 + (10 - offset) * DAY, 1, 1, 1, 1, 0]) } } };
    const empty = { ...hourly, data: { attributes: { ohlcv_list: [] } } };
    const payload = await fetchPoolRangeApr(POOL, { fetcher: fetcher({ daily: zeros, hourly: empty }).impl, nowSeconds: NOW, retry: NO_WAIT, gate: gate(), bypassCache: true });
    expect(payload.sample.degraded).toBe(false);
    expect(payload.sample.issues).toContain("no trades in the sample window");
    for (const preset of payload.presets) {
      expect(preset.estimate.status).toBe("ok");
      if (preset.estimate.status === "ok") expect(preset.estimate.aprPct).toBe(0);
    }
  });

  it("no candles but real volume stays degraded (candles missing is not the same as no trades)", async () => {
    const empty = { ...hourly, data: { attributes: { ohlcv_list: [] } } };
    const payload = await fetchPoolRangeApr(POOL, { fetcher: fetcher({ hourly: empty }).impl, nowSeconds: NOW, retry: NO_WAIT, gate: gate(), bypassCache: true });
    expect(payload.sample.degraded).toBe(true);
  });

  it("does not retry a 404 (pool not indexed)", async () => {
    let hourCalls = 0;
    const healthy = fetcher().impl;
    const impl: typeof fetch = async (input, init) => {
      if (String(input).includes("/ohlcv/hour")) { hourCalls++; return new Response("{}", { status: 404 }); }
      return healthy(input, init);
    };
    const payload = await fetchPoolRangeApr(POOL, { fetcher: impl, nowSeconds: NOW, retry: NO_WAIT, gate: gate(), bypassCache: true });
    expect(hourCalls).toBe(1);
    expect(payload.sample.degraded).toBe(true);
  });

  it("keeps earlier good price history when a later fetch fails (stale-if-error), but not forever", async () => {
    const good = await fetchPoolRangeApr(POOL, { fetcher: fetcher().impl, nowSeconds: NOW, retry: NO_WAIT, gate: gate(), bypassCache: true });
    const broken = fetcher({ hourlyOk: false }).impl;
    const soon = await fetchPoolRangeApr(POOL, { fetcher: broken, nowSeconds: NOW + 3_600, retry: NO_WAIT, gate: gate(), bypassCache: true });
    expect(soon.sample).toMatchObject({ degraded: false, occupancySource: "hourly-candles", priceHistoryStale: true });
    expect(good.sample.priceHistoryStale).toBeUndefined();
    expect(soon.sample.issues.some((issue) => /using price history cached 60 min ago/.test(issue))).toBe(true);
    expect(soon.presets.map((preset) => preset.estimate.status)).toEqual(good.presets.map((preset) => preset.estimate.status));
    const day2 = await fetchPoolRangeApr(POOL, { fetcher: broken, nowSeconds: NOW + 47 * 3_600, retry: NO_WAIT, gate: gate(), bypassCache: true });
    expect(day2.sample).toMatchObject({ degraded: false, priceHistoryStale: true }); // saved history is usable up to 48h
    const later = await fetchPoolRangeApr(POOL, { fetcher: broken, nowSeconds: NOW + 49 * 3_600, retry: NO_WAIT, gate: gate(), bypassCache: true });
    expect(later.sample.degraded).toBe(true);
  });

  it("re-checks a degraded profile within a minute instead of serving it for the 30 minute TTL", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date(NOW * 1000));
      const first = await fetchPoolRangeApr(POOL, { fetcher: fetcher({ hourlyOk: false }).impl, nowSeconds: NOW, retry: NO_WAIT, gate: gate() });
      expect(first.sample.degraded).toBe(true);
      vi.setSystemTime(new Date((NOW + 30) * 1000));
      const stillDegraded = await fetchPoolRangeApr(POOL, { fetcher: fetcher().impl, nowSeconds: NOW + 30, retry: NO_WAIT, gate: gate() });
      expect(stillDegraded.sample.degraded).toBe(true); // inside the 45 s degraded TTL (no hammering of a throttled upstream)
      vi.setSystemTime(new Date((NOW + 50) * 1000));
      const recovered = await fetchPoolRangeApr(POOL, { fetcher: fetcher().impl, nowSeconds: NOW + 50, retry: NO_WAIT, gate: gate() });
      expect(recovered.sample).toMatchObject({ degraded: false, occupancySource: "hourly-candles" });
      vi.setSystemTime(new Date((NOW + 20 * 60) * 1000));
      const { impl, calls } = fetcher();
      await fetchPoolRangeApr(POOL, { fetcher: impl, nowSeconds: NOW + 20 * 60, retry: NO_WAIT, gate: gate() });
      expect(calls).toHaveLength(0); // a good profile is still cached for 30 minutes
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails clearly when Raydium pool economics are unavailable", async () => {
    await expect(fetchPoolRangeApr(POOL, { fetcher: fetcher({ ids: null }).impl, nowSeconds: NOW, retry: NO_WAIT, gate: gate(), bypassCache: true }))
      .rejects.toThrow(/economics unavailable/i);
  });

  it("fails clearly when no volume source exists or TVL is zero", async () => {
    const noWeek = { ...ids, data: [{ ...ids.data[0], week: {} }] };
    await expect(fetchPoolRangeApr(POOL, { fetcher: fetcher({ ids: noWeek, daily: null }).impl, nowSeconds: NOW, retry: NO_WAIT, gate: gate(), bypassCache: true }))
      .rejects.toThrow(/volume unavailable/i);
    const noTvl = { ...ids, data: [{ ...ids.data[0], tvl: 0 }] };
    await expect(fetchPoolRangeApr(POOL, { fetcher: fetcher({ ids: noTvl }).impl, nowSeconds: NOW, retry: NO_WAIT, gate: gate(), bypassCache: true }))
      .rejects.toThrow(/TVL unavailable/i);
  });

  it("caches per pool and de-duplicates concurrent callers (one upstream round trip)", async () => {
    const { impl, calls } = fetcher();
    const [first, second] = await Promise.all([
      fetchPoolRangeApr(POOL, { fetcher: impl, nowSeconds: NOW, retry: NO_WAIT, gate: gate() }),
      fetchPoolRangeApr(POOL, { fetcher: impl, nowSeconds: NOW, retry: NO_WAIT, gate: gate() }),
    ]);
    expect(first).toEqual(second);
    await fetchPoolRangeApr(POOL, { fetcher: impl, nowSeconds: NOW, retry: NO_WAIT, gate: gate() });
    expect(calls).toHaveLength(3); // ids + day + hour, once
    expect(readChain).toHaveBeenCalledTimes(1);
  });

  it("does not retry a failing upstream on every call (short negative cache)", async () => {
    const { impl, calls } = fetcher({ ids: null });
    await expect(fetchPoolRangeApr(POOL, { fetcher: impl, nowSeconds: NOW, retry: NO_WAIT, gate: gate() })).rejects.toThrow();
    const before = calls.length;
    await expect(fetchPoolRangeApr(POOL, { fetcher: impl, nowSeconds: NOW, retry: NO_WAIT, gate: gate() })).rejects.toThrow();
    expect(calls.length).toBe(before);
  });
});
