import { afterEach, describe, expect, it, vi } from "vitest";
import { buildMeteoraDailyAprPoints, clearMeteoraPoolDailyAprCache, DEGRADED_CACHE_TTL_MS, fetchMeteoraPoolDailyApr, parseMeteoraPoolSnapshot } from "./meteora-daily-apr";

const DAY = 86_400;
const D0 = 1_793_145_600; // 2026-10-28 00:00 UTC
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

afterEach(() => clearMeteoraPoolDailyAprCache());

describe("parseMeteoraPoolSnapshot", () => {
  it("reads TVL, base fee (percent → fraction), 24h fee/TVL (percent → APR percent) and creation (ms → s)", () => {
    expect(parseMeteoraPoolSnapshot({ tvl: 1000, pool_config: { base_fee_pct: 0.25 }, fee_tvl_ratio: { "24h": 0.002 }, created_at: 1_793_157_783_000 }))
      .toEqual({ tvlUsd: 1000, baseFeeRate: 0.0025, dayFeeAprPct: 0.73, createdAtSeconds: 1_793_157_783 });
  });
  it("leaves missing or invalid fields null", () => {
    expect(parseMeteoraPoolSnapshot({ tvl: -1, pool_config: null, fee_tvl_ratio: { "24h": "x" } }))
      .toEqual({ tvlUsd: null, baseFeeRate: null, dayFeeAprPct: null, createdAtSeconds: null });
  });
});

describe("buildMeteoraDailyAprPoints", () => {
  const days = [0, 1, 2, 3].map((i) => ({ time: D0 + i * DAY, volumeUsd: 1000 * (i + 1), feesUsd: i === 2 ? 0 : 1 }));
  it("drops the creation day and the incomplete current day; zero-fee days are 0 %, not gaps", () => {
    const points = buildMeteoraDailyAprPoints({ days, tvlUsd: 36_500, createdAtSeconds: D0 + 3 * 3600, nowSeconds: D0 + 3 * DAY + 600 });
    expect(points.map((point) => point.date)).toEqual(["2026-10-29", "2026-10-30"]);
    expect(points[0]).toEqual({ time: D0 + DAY, date: "2026-10-29", aprPct: 1, volumeUsd: 2000, tvlUsd: 36_500 });
    expect(points[1]!.aprPct).toBe(0);
  });
  it("without TVL every point has a null APR (volume kept)", () => {
    const points = buildMeteoraDailyAprPoints({ days, tvlUsd: null, createdAtSeconds: null, nowSeconds: D0 + 10 * DAY });
    expect(points).toHaveLength(4);
    expect(points.every((point) => point.aprPct === null && point.tvlUsd === null && point.volumeUsd !== null)).toBe(true);
  });
});

describe("fetchMeteoraPoolDailyApr", () => {
  const pool = { tvl: 36_500, pool_config: { base_fee_pct: 0.01 }, fee_tvl_ratio: { "24h": 0.001 }, created_at: (D0 - DAY) * 1000 };
  const history = { data: [{ timestamp: D0, volume: 10_000, fees: 1, protocol_fees: 0.1 }] };
  it("keeps the volume series when only the pool endpoint fails, and says which source is missing", async () => {
    const fetcher = vi.fn(async (url: string | URL | Request) => (String(url).includes("/volume/history") ? json(history) : json({}, 503)));
    const result = await fetchMeteoraPoolDailyApr("P", { fetcher: fetcher as typeof fetch, nowSeconds: D0 + 2 * DAY, bypassCache: true });
    expect(result.points).toEqual([{ time: D0, date: "2026-10-28", aprPct: null, volumeUsd: 10_000, tvlUsd: null }]);
    expect(result.sources).toEqual(["https://dlmm.datapi.meteora.ag/pools/{address}/volume/history (daily USD volume and fees)"]);    expect(result.degraded).toBe("the Meteora datapi pool endpoint did not answer (Upstream request failed (503))");
  });
  it("throws a plain error when both endpoints fail", async () => {
    const fetcher = vi.fn(async () => json({}, 429));
    await expect(fetchMeteoraPoolDailyApr("P", { fetcher: fetcher as typeof fetch, bypassCache: true }))
      .rejects.toThrow("Meteora datapi did not answer for this pool (pool: Upstream request failed (429); volume history: Upstream request failed (429))");
  });
  it("uses a day's stored TVL, asks the store for the series' UTC day range, and says why when the store cannot be read", async () => {
    const fetcher = vi.fn(async (url: string | URL | Request) => (String(url).includes("/volume/history") ? json(history) : json(pool)));
    const reader = vi.fn(async () => new Map([["2026-10-28", 10_000]]));
    const stored = await fetchMeteoraPoolDailyApr("P", { fetcher: fetcher as typeof fetch, nowSeconds: D0 + 2 * DAY, bypassCache: true, storedTvl: reader });
    expect(reader).toHaveBeenCalledWith("P", "2026-08-01", "2026-10-29");
    expect(stored.points).toEqual([{ time: D0, date: "2026-10-28", aprPct: expect.closeTo(3.65, 10), volumeUsd: 10_000, tvlUsd: 10_000 }]);
    expect(stored.assumptions).toMatch(/1 of 1 days use that day's stored TVL\. Other days use today's TVL/);
    const failing = await fetchMeteoraPoolDailyApr("P", { fetcher: fetcher as typeof fetch, nowSeconds: D0 + 2 * DAY, bypassCache: true,
      storedTvl: async () => { throw new Error("store down"); } });
    expect(failing.points[0]).toMatchObject({ tvlUsd: 36_500, aprPct: expect.closeTo(1, 10) });
    expect(failing.assumptions).toMatch(/no stored daily TVL covers these days \(the stored daily TVL could not be read\)\. Other days use today's TVL/);
  });
  it("caches per pool for an hour", async () => {
    const fetcher = vi.fn(async (url: string | URL | Request) => (String(url).includes("/volume/history") ? json(history) : json(pool)));
    const options = { fetcher: fetcher as typeof fetch, nowSeconds: D0 + 2 * DAY };
    const first = await fetchMeteoraPoolDailyApr("P", options);
    expect(await fetchMeteoraPoolDailyApr("P", options)).toBe(first);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(first.published).toEqual({ dayFeeApr: 0.365, weekFeeApr: null, monthFeeApr: null });
  });
  it("reuses a degraded answer for one minute only, then asks again", async () => {
    vi.useFakeTimers({ now: Date.parse("2026-11-01T00:00:00Z") });
    try {
      let storeUp = false;
      const fetcher = vi.fn(async (url: string | URL | Request) => (String(url).includes("/volume/history") ? json(history) : json(pool)));
      const options = { fetcher: fetcher as typeof fetch, nowSeconds: D0 + 2 * DAY,
        storedTvl: async () => { if (!storeUp) throw new Error("store down"); return new Map([["2026-10-28", 10_000]]); } };
      const degraded = await fetchMeteoraPoolDailyApr("Q", options);
      expect(degraded.degraded).toBe("the stored daily TVL could not be read");
      expect(await fetchMeteoraPoolDailyApr("Q", options)).toBe(degraded);
      vi.advanceTimersByTime(DEGRADED_CACHE_TTL_MS);
      storeUp = true;
      const full = await fetchMeteoraPoolDailyApr("Q", options);
      expect(full).not.toBe(degraded);
      expect(full.degraded).toBeUndefined();
      expect(full.points[0]!.tvlUsd).toBe(10_000);
      vi.advanceTimersByTime(DEGRADED_CACHE_TTL_MS);
      expect(await fetchMeteoraPoolDailyApr("Q", options)).toBe(full);
    } finally {
      vi.useRealTimers();
    }
  });
});
