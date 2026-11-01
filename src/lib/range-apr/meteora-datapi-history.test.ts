import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { profileFromHistory } from "../pool-range-apr";

import {
  datapiFeeCrossCheck, DATAPI_HOURLY_SPAN_SECONDS, feeTotals, hourlySpans, invertCandles, meteoraDatapiHistory, MeteoraDatapiError,
  parseDatapiOhlcv, parseDatapiVolumeHistory,
} from "./meteora-datapi-history";

const DAY = 86_400;
const D0 = 1_793_491_200; // 2026-11-01T00:00Z (the open day)
const NOW = D0 + 3 * 3_600 + 42;
const POOL = "8k2c9Kiavx5pbWc2dmzhL7vFp11sLgMcKFfSueq8haAh";
const X = "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB", Y = "Xs" + "1".repeat(41);
const CREATED = D0 - 4 * DAY + 3 * 3_600; // created on day D0-4

/** Zero rows before creation (as datapi returns them), then 3 traded days, then an empty complete day. */
const volumeBody = {
  timeframe: "24h",
  data: [7, 6, 5, 4, 3, 2, 1, 0].map((back) => {
    const time = D0 - back * DAY;
    const volume = back === 4 ? 80_000 : back === 3 ? 50_000 : back === 2 ? 70_000 : 0;
    return { timestamp: time, timestamp_str: "", volume, fees: volume * 0.0001, protocol_fees: volume * 0.00001 };
  }),
};
const candle = (time: number, price: number, volume = 100) => ({ timestamp: time, open: price, high: price * 1.001, low: price * 0.999, close: price, volume });

function fakeFetch(handler: (url: URL) => { status?: number; body?: unknown; error?: Error }) {
  const calls: URL[] = [];
  const impl: typeof fetch = async (input) => {
    const url = new URL(String(input));
    calls.push(url);
    const { status = 200, body = {}, error } = handler(url);
    if (error) throw error;
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  };
  return { impl, calls };
}

const history = meteoraDatapiHistory({ mintX: X, mintY: Y, createdAtSeconds: CREATED });

describe("Meteora datapi history", () => {
  it("parses volume history and OHLCV, dropping malformed rows", () => {
    expect(parseDatapiVolumeHistory({ data: [{ timestamp: 1, volume: 2, fees: 0.1, protocol_fees: 0.01 }, { timestamp: 2, volume: -1 }, { volume: 3 }] }))
      .toEqual([{ time: 1, volumeUsd: 2, feesUsd: 0.1, protocolFeesUsd: 0.01 }]);
    expect(parseDatapiVolumeHistory({ nope: [] })).toBeNull();
    expect(parseDatapiOhlcv({ data: [candle(10, 2), { ...candle(11, 2), low: 0 }, { timestamp: 12 }] })).toEqual([
      { time: 10, open: 2, high: 2.002, low: 1.998, close: 2, volume: 100 }]);
    expect(parseDatapiOhlcv(null)).toBeNull();
  });

  it("inverts a price path (1/p, high and low swapped)", () => {
    const [inverted] = invertCandles([{ time: 1, open: 2, high: 4, low: 1, close: 2, volume: 7 }]);
    expect(inverted).toEqual({ time: 1, open: 0.5, high: 1, low: 0.25, close: 0.5, volume: 7 });
  });

  it("reads 7 complete days of 1h candles in two spans of at most ~3.5 days", () => {
    const spans = hourlySpans(NOW);
    expect(spans).toHaveLength(2);
    expect(spans[0]!.start).toBe(D0 - 7 * DAY);
    expect(spans.at(-1)!.end).toBe(D0);
    for (const span of spans) expect(span.end - span.start).toBeLessThanOrEqual(DATAPI_HOURLY_SPAN_SECONDS);
    expect(spans[1]!.start).toBe(spans[0]!.end);
  });

  it("cross-checks datapi fees against the on-chain base fee and protocol share", () => {
    const totals = feeTotals([{ time: 0, volumeUsd: 600, feesUsd: 0.06, protocolFeesUsd: 0.006 }, { time: 1, volumeUsd: 400, feesUsd: 0.04, protocolFeesUsd: 0.004 }]);
    expect(totals).toEqual({ volumeUsd: 1_000, feesUsd: expect.closeTo(0.1, 12), protocolFeesUsd: expect.closeTo(0.01, 12) });
    expect(datapiFeeCrossCheck(totals, 0.0001, 0.1)).toEqual([]);
    // Datapi runs a few percent under the base fee on calm pools (0.93x measured): not flagged.
    expect(datapiFeeCrossCheck({ ...totals, feesUsd: 0.093, protocolFeesUsd: 0.0093 }, 0.0001, 0.1)).toEqual([]);
    expect(datapiFeeCrossCheck(totals, 0.001, 0.1)[0]).toMatch(/below the 0.1000% on-chain base fee/);
    expect(datapiFeeCrossCheck(totals, 0.0001, 0.5)[0]).toMatch(/protocol fees 10.0% of fees, on-chain share 50.0%/);
    expect(datapiFeeCrossCheck({ volumeUsd: 0, feesUsd: 0, protocolFeesUsd: 0 }, 0.0001, 0.1)).toEqual([]);
  });

  it("loads daily volume (1 call) and hourly candles (2 calls), averaging only the days the pool existed", async () => {
    const { impl, calls } = fakeFetch((url) => {
      if (url.pathname.endsWith("/volume/history")) return { body: volumeBody };
      const start = Number(url.searchParams.get("start_time"));
      // Overlapping candle at the span boundary is de-duplicated.
      return { body: { data: [candle(start, 1.0005), candle(start + 3_600, 1.0006)] } };
    });
    const result = await history.load(POOL, impl, NOW);
    expect(calls.map((url) => `${url.pathname}?${url.searchParams.get("timeframe")}`)).toEqual([
      `/pools/${POOL}/volume/history?24h`, `/pools/${POOL}/ohlcv?1h`, `/pools/${POOL}/ohlcv?1h`]);
    expect(calls[0]!.searchParams.get("start_time")).toBe(String(D0 - 7 * DAY));
    // Created on D0-4: 4 complete days (D0-4 .. D0-1), 200k total; the zero rows before creation do not count.
    expect(result.daily).toEqual({ avgDailyVolumeUsd: 50_000, days: 4, source: "meteora-datapi-daily" });
    expect(result.candles).toHaveLength(4);
    expect(result.candles!.map((c) => c.time)).toEqual([...result.candles!.map((c) => c.time)].sort((a, b) => a - b));
    expect(result).toMatchObject({ baseMint: X, quoteMint: Y, issues: [] });
    expect(result.dailyPoints).toHaveLength(7);
    expect(result.sources.join(" ")).toMatch(/volume\/history.*ohlcv 1h/);
  });

  it("without a creation time, averages from the first traded day (like GeckoTerminal's first candle)", async () => {
    const { impl } = fakeFetch((url) => (url.pathname.endsWith("/volume/history") ? { body: volumeBody } : { body: { data: [] } }));
    const result = await meteoraDatapiHistory({ mintX: X, mintY: Y }).load(POOL, impl, NOW);
    expect(result.daily).toEqual({ avgDailyVolumeUsd: 50_000, days: 4, source: "meteora-datapi-daily" });
    expect(result.candles).toEqual([]);
  });

  it("throws datapi-429 on a rate limit without retrying", async () => {
    const { impl, calls } = fakeFetch((url) => (url.pathname.endsWith("/volume/history") ? { status: 429 } : { body: { data: [] } }));
    const error = await history.load(POOL, impl, NOW).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MeteoraDatapiError);
    expect((error as MeteoraDatapiError).code).toBe("datapi-429");
    expect(calls).toHaveLength(3); // one attempt per URL
  });

  it("throws datapi-timeout when a call times out", async () => {
    const timeout = new DOMException("The operation was aborted due to timeout", "TimeoutError");
    const { impl } = fakeFetch((url) => (url.pathname.endsWith("/ohlcv") ? { error: timeout } : { body: volumeBody }));
    await expect(history.load(POOL, impl, NOW)).rejects.toMatchObject({ code: "datapi-timeout" });
  });

  it("reports other failures as issues and leaves the price path missing (no GeckoTerminal fallback)", async () => {
    const { impl, calls } = fakeFetch((url) => (url.pathname.endsWith("/ohlcv") ? { status: 500 } : { body: volumeBody }));
    const result = await history.load(POOL, impl, NOW);
    expect(result.candles).toBeNull();
    expect(result.daily).not.toBeNull();
    expect(result.issues).toEqual(["Meteora datapi hourly candles: Upstream request failed (500)"]);
    expect(calls.every((url) => url.hostname === "dlmm.datapi.meteora.ag")).toBe(true);
  });
});

describe("profileFromHistory", () => {
  const economics = { mintA: X, mintB: Y, decimalsA: 8, decimalsB: 8, feeRate: 0.0001, tvlUsd: 1, price: 2, mintAmountA: 1, mintAmountB: 1, protocolFeeRate: 100_000, fundFeeRate: 0, weekVolumeUsd: null, dayFeeApr: null, weekFeeApr: null };
  const base = {
    daily: { avgDailyVolumeUsd: 5, days: 7, source: "meteora-datapi-daily" as const },
    candles: [{ time: 1, open: 2, high: 4, low: 1, close: 2, volume: 3 }],
    baseMint: X, quoteMint: Y, dailyPoints: [{ time: 1, volumeUsd: 1_000, feesUsd: 0.1, protocolFeesUsd: 0.01 }],
    sources: ["datapi"], issues: [], observedAt: { daily: "d", hourly: "h" },
  };
  const source = { source: "econ", protocol: "meteora-dlmm" };

  it("keeps Y-per-X candles when the economics are X/Y, flips them when Y/X, and drops them on a mint mismatch", () => {
    expect(profileFromHistory(economics, "e", source, base)).toMatchObject({
      candles: base.candles, daily: base.daily, protocol: "meteora-dlmm", sources: ["econ", "datapi"], issues: [],
      observedAt: { economics: "e", daily: "d", hourly: "h" },
    });
    const flipped = profileFromHistory({ ...economics, mintA: Y, mintB: X }, "e", source, base);
    expect(flipped.candles).toEqual([{ time: 1, open: 0.5, high: 1, low: 0.25, close: 0.5, volume: 3 }]);
    const other = profileFromHistory({ ...economics, mintA: "Z" }, "e", source, base);
    expect(other.candles).toBeNull();
    expect(other.issues).toContain("hourly candles: mints do not match the pool");
    expect(other.observedAt!.hourly).toBeNull();
  });

  it("carries the window's fee totals for the on-chain cross-check", () => {
    expect(profileFromHistory(economics, "e", source, base).feeTotals).toEqual({ volumeUsd: 1_000, feesUsd: 0.1, protocolFeesUsd: 0.01 });
    expect(profileFromHistory(economics, "e", source, { ...base, dailyPoints: [] }).feeTotals).toBeUndefined();
  });
});
