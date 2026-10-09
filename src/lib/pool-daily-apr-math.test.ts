import { describe, expect, it } from "vitest";
import {
  buildPoolDailyAprPoints,
  parseGeckoDailyVolumes,
  parseRaydiumLiquidityLine,
  parseRaydiumPoolSnapshot,
} from "./pool-daily-apr-math";

const D1 = 1_791_331_200; // 2026-10-07
const D2 = 1_791_417_600; // 2026-10-08
const D3 = 1_791_504_000; // 2026-10-09

describe("pool-daily-apr-math", () => {
  it("parses Raydium liquidity line TVL points", () => {
    const rows = parseRaydiumLiquidityLine({
      success: true,
      data: { count: 2, line: [{ time: D1 + 10, liquidity: 10_000 }, { time: D2, liquidity: "12000.5" }] },
    });
    expect(rows).toEqual([
      { time: D1, tvlUsd: 10_000 },
      { time: D2, tvlUsd: 12_000.5 },
    ]);
  });

  it("parses GeckoTerminal daily OHLCV volume (index 5)", () => {
    const rows = parseGeckoDailyVolumes({
      data: {
        attributes: {
          ohlcv_list: [
            [D3, 1, 2, 0.5, 1.5, 50_000],
            [D2, 1, 2, 0.5, 1.5, "40000"],
          ],
        },
      },
    });
    expect(rows).toEqual([
      { time: D3, volumeUsd: 50_000 },
      { time: D2, volumeUsd: 40_000 },
    ]);
  });

  it("parses Raydium pool snapshot feeRate and window APRs", () => {
    const snap = parseRaydiumPoolSnapshot({
      success: true,
      data: [
        {
          feeRate: 0.0001,
          tvl: 100_000,
          day: { volume: 80_000, volumeFee: 8, feeApr: 2.92 },
          week: { feeApr: 2.1 },
          month: { feeApr: 1.8 },
        },
      ],
    });
    expect(snap.feeRate).toBeCloseTo(0.0001);
    expect(snap.dayFeeApr).toBeCloseTo(2.92);
    expect(snap.weekFeeApr).toBeCloseTo(2.1);
    expect(snap.monthFeeApr).toBeCloseTo(1.8);
  });

  it("estimates daily APR only when volume and TVL both exist", () => {
    const points = buildPoolDailyAprPoints({
      volumes: [
        { time: D1, volumeUsd: 10_000 },
        { time: D3, volumeUsd: 20_000 },
      ],
      tvl: [
        { time: D1, tvlUsd: 100_000 },
        { time: D2, tvlUsd: 110_000 },
      ],
      snapshot: {
        feeRate: 0.001,
        tvlUsd: 120_000,
        dayVolumeUsd: null,
        dayVolumeFeeUsd: null,
        dayFeeApr: 6,
        weekFeeApr: 5,
        monthFeeApr: 4,
      },
      nowSeconds: D3,
    });
    const byDate = Object.fromEntries(points.map((p) => [p.date, p]));
    // 10000 * 0.001 / 100000 * 365 * 100 = 3.65
    expect(byDate["2026-10-07"]?.aprPct).toBeCloseTo(3.65, 8);
    // TVL without volume → gap
    expect(byDate["2026-10-08"]?.aprPct).toBeNull();
    // Current UTC day is omitted even when volume/TVL exist
    expect(byDate["2026-10-09"]).toBeUndefined();
  });

  it("excludes the current incomplete UTC day when the clock is mid-day", () => {
    const now = D3 + 15 * 3600; // 2026-10-09 15:00 UTC
    const points = buildPoolDailyAprPoints({
      volumes: [
        { time: D2, volumeUsd: 10_000 },
        { time: D3, volumeUsd: 100 },
      ],
      tvl: [
        { time: D2, tvlUsd: 100_000 },
        { time: D3, tvlUsd: 100_000 },
      ],
      snapshot: {
        feeRate: 0.001,
        tvlUsd: 100_000,
        dayVolumeUsd: 50,
        dayVolumeFeeUsd: null,
        dayFeeApr: 0.18,
        weekFeeApr: null,
        monthFeeApr: null,
      },
      nowSeconds: now,
    });
    expect(points.map((p) => p.date)).toEqual(["2026-10-08"]);
    expect(points[0]?.aprPct).toBeCloseTo(3.65, 8);
    expect(points.find((p) => p.date === "2026-10-09")).toBeUndefined();
  });

  it("does not invent points when feeRate is missing", () => {
    const points = buildPoolDailyAprPoints({
      volumes: [{ time: D1, volumeUsd: 10_000 }],
      tvl: [{ time: D1, tvlUsd: 100_000 }],
      snapshot: {
        feeRate: null,
        tvlUsd: 100_000,
        dayVolumeUsd: null,
        dayVolumeFeeUsd: null,
        dayFeeApr: 1,
        weekFeeApr: null,
        monthFeeApr: null,
      },
      nowSeconds: D2,
    });
    expect(points).toHaveLength(1);
    expect(points[0]?.aprPct).toBeNull();
  });

  it("treats zero volume as a real 0% day, not a gap", () => {
    const points = buildPoolDailyAprPoints({
      volumes: [{ time: D1, volumeUsd: 0 }],
      tvl: [{ time: D1, tvlUsd: 50_000 }],
      snapshot: {
        feeRate: 0.0005,
        tvlUsd: 50_000,
        dayVolumeUsd: null,
        dayVolumeFeeUsd: null,
        dayFeeApr: null,
        weekFeeApr: null,
        monthFeeApr: null,
      },
      nowSeconds: D2,
    });
    expect(points[0]?.aprPct).toBe(0);
  });
});
