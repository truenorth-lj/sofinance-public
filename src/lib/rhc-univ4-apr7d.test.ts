import { describe, expect, it } from "vitest";
import { rhcDailyOhlcvUrl, rhcPoolApr7d } from "./rhc-univ4-apr7d";

const DAY = 86_400;
// 2026-10-30 02:00 UTC: the last complete UTC day starts 2026-10-29 00:00 UTC.
const now = Date.UTC(2026, 9, 30, 2) / 1000;
const day = (daysAgo: number) => Date.UTC(2026, 9, 29) / 1000 - daysAgo * DAY;
const fee = { zeroForOne: 50, oneForZero: 51 };

describe("rhcPoolApr7d", () => {
  it("averages the last 7 complete UTC days (missing days = 0) × fee rate / TVL × 365", () => {
    const points = [{ time: day(0), volumeUsd: 70 }, { time: day(3), volumeUsd: 70 }, { time: day(6), volumeUsd: 70 }, { time: day(8), volumeUsd: 1e9 },
      { time: Date.UTC(2026, 9, 30) / 1000, volumeUsd: 1e9 }];
    const apr = rhcPoolApr7d({ points, nowSeconds: now, feePips: fee, tvlUsd: 50_000 })!;
    expect(apr).toMatchObject({ days: 7, avgDailyVolumeUsd: 30, tvlUsd: 50_000, source: "geckoterminal", attribution: { text: "Data: GeckoTerminal" } });
    expect(apr.feeRatePct).toBeCloseTo(0.00505, 9);
    expect(apr.estimatedPoolFeeAprPct).toBeCloseTo(0.0000505 * 30 / 50_000 * 365 * 100, 12);
  });

  it("averages a pool younger than 7 days over its own age", () => {
    const apr = rhcPoolApr7d({ points: [{ time: day(2), volumeUsd: 30 }, { time: day(0), volumeUsd: 0 }], nowSeconds: now, feePips: fee, tvlUsd: 1000 })!;
    expect(apr.days).toBe(3);
    expect(apr.avgDailyVolumeUsd).toBe(10);
  });

  it("is null (shown as —, never 0%) without daily data, fee or TVL", () => {
    expect(rhcPoolApr7d({ points: null, nowSeconds: now, feePips: fee, tvlUsd: 1000 })).toBeNull();
    expect(rhcPoolApr7d({ points: [], nowSeconds: now, feePips: fee, tvlUsd: 1000 })).toBeNull();
    expect(rhcPoolApr7d({ points: [{ time: day(0), volumeUsd: 5 }], nowSeconds: now, feePips: null, tvlUsd: 1000 })).toBeNull();
    expect(rhcPoolApr7d({ points: [{ time: day(0), volumeUsd: 5 }], nowSeconds: now, feePips: fee, tvlUsd: 0 })).toBeNull();
    expect(rhcPoolApr7d({ points: [{ time: day(0), volumeUsd: 5 }], nowSeconds: now, feePips: fee, tvlUsd: null })).toBeNull();
  });

  it("uses GeckoTerminal's robinhood network daily USD candles", () => {
    expect(rhcDailyOhlcvUrl("0xABC")).toBe("https://api.geckoterminal.com/api/v2/networks/robinhood/pools/0xabc/ohlcv/day?aggregate=1&limit=30&currency=usd");
  });
});
