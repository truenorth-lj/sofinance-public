import { describe, expect, it } from "vitest";
import type { RawCandle } from "./gecko-candles";
import { binVolumeShares, candlesToTickCandles, type TickCandle } from "./occupancy";
import { exactTickFromUiPrice, uiPriceFromTick } from "./tick-math";

const flat = (count: number, liquidity = 100, firstTick = 0, spacing = 1) =>
  Array.from({ length: count }, (_, index) => ({ tick: firstTick + index * spacing, liquidity }));
const candle = (lowTick: number, highTick: number, weight = 1): TickCandle => ({ lowTick, highTick, weight });
const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);

describe("binVolumeShares", () => {
  it("puts a point-mass candle in its bin", () => {
    const result = binVolumeShares([candle(2.4, 2.4)], flat(6), 1)!;
    expect(result.shares).toEqual([0, 0, 1, 0, 0, 0]);
    expect(result.outsideShare).toBe(0);
  });

  it("splits a candle across the bins it crossed in proportion to overlap (flat liquidity)", () => {
    const result = binVolumeShares([candle(1.5, 3.5)], flat(6), 1)!;
    expect(result.shares[1]).toBeCloseTo(0.25, 3);
    expect(result.shares[2]).toBeCloseTo(0.5, 3);
    expect(result.shares[3]).toBeCloseTo(0.25, 3);
    expect(sum(result.shares)).toBeCloseTo(1, 9);
  });

  it("weights bins by the tokens needed to cross them: deeper bins carry more volume", () => {
    const bins = [{ tick: 0, liquidity: 100 }, { tick: 1, liquidity: 300 }];
    const result = binVolumeShares([candle(0, 2)], bins, 1)!;
    expect(result.shares[1]! / result.shares[0]!).toBeCloseTo(3, 3);
  });

  it("gives empty bins no volume, so a lone new LP cannot be handed 100% of fees there", () => {
    const bins = [{ tick: 0, liquidity: 0 }, { tick: 1, liquidity: 100 }];
    const result = binVolumeShares([candle(0, 2), candle(0.5, 0.5)], bins, 1)!;
    expect(result.shares[0]).toBe(0);
    expect(result.shares[1]).toBeCloseTo(0.5, 6); // only the first candle can be served
    expect(result.outsideShare).toBeCloseTo(0.5, 6);
  });

  it("reports volume outside the window as unplaced, keeping the in-window fraction of a straddling candle", () => {
    const result = binVolumeShares([candle(-10, -5), candle(4, 8, 3)], flat(6), 1)!;
    // The second candle carries 3/4 of the weight and half of its path lies in [4, 6): 3/8 is placed, split over two bins.
    expect(result.shares[4]).toBeCloseTo(0.1875, 3);
    expect(result.shares[5]).toBeCloseTo(0.1875, 3);
    expect(result.outsideShare).toBeCloseTo(0.25 + 0.375, 3);
  });

  it("respects spacing > 1 and negative ticks", () => {
    const bins = flat(4, 100, -120, 60); // [-120,-60) [-60,0) [0,60) [60,120)
    const result = binVolumeShares([candle(-90, -30)], bins, 60)!;
    expect(result.shares[0]).toBeCloseTo(0.5, 2);
    expect(result.shares[1]).toBeCloseTo(0.5, 2);
  });

  it("returns null without any weight or bins", () => {
    expect(binVolumeShares([], flat(3), 1)).toBeNull();
    expect(binVolumeShares([candle(0, 1, 0)], flat(3), 1)).toBeNull();
    expect(binVolumeShares([candle(0, 1)], [], 1)).toBeNull();
  });
});

describe("candlesToTickCandles", () => {
  const price = (tick: number) => uiPriceFromTick(tick, 6, 6);
  const raw = (time: number, openTick: number, lowTick: number, highTick: number, volume = 1): RawCandle => ({
    time, open: price(openTick), low: price(lowTick), high: price(highTick), close: price(openTick), volume,
  });
  const base = { decimalsA: 6, decimalsB: 6, feeRate: 0 } as const;

  it("converts prices to ticks and keeps volume as the weight", () => {
    const [first] = candlesToTickCandles([raw(0, 100, 98, 104, 5)], { ...base, currentExactTick: 0, rebase: false });
    expect(first!.lowTick).toBeCloseTo(98, 6);
    expect(first!.highTick).toBeCloseTo(104, 6);
    expect(first!.weight).toBe(5);
  });

  it("re-bases every UTC day so its first open sits at the current tick", () => {
    const day = 86_400;
    const result = candlesToTickCandles(
      [raw(0, 100, 99, 103), raw(3_600, 102, 101, 106), raw(day, 500, 498, 502)],
      { ...base, currentExactTick: 10 },
    );
    expect(result[0]!.lowTick).toBeCloseTo(9, 5);
    expect(result[0]!.highTick).toBeCloseTo(13, 5);
    expect(result[1]!.lowTick).toBeCloseTo(11, 5); // same shift (-90) as the first candle of that day
    expect(result[2]!.lowTick).toBeCloseTo(8, 5); // new day, new shift (-490)
  });

  it("removes fee noise from each side, collapsing narrow candles to their midpoint", () => {
    // 20 bps fee = 2 ticks per side
    const [wide, narrow] = candlesToTickCandles(
      [raw(0, 100, 90, 110), raw(10, 100, 99, 101)],
      { ...base, feeRate: 0.0002, currentExactTick: 0, rebase: false },
    );
    expect(wide!.lowTick).toBeCloseTo(92, 4);
    expect(wide!.highTick).toBeCloseTo(108, 4);
    expect(narrow!.lowTick).toBeCloseTo(100, 4);
    expect(narrow!.highTick).toBeCloseTo(100, 4);
  });

  it("skips zero-volume candles but still uses them to anchor the day", () => {
    const result = candlesToTickCandles([raw(0, 100, 99, 101, 0), raw(60, 120, 119, 121, 2)], { ...base, currentExactTick: 0 });
    expect(result).toHaveLength(1);
    expect(result[0]!.lowTick).toBeCloseTo(119 - 100, 4); // shifted by the zero-volume candle's open
  });

  it("uses decimals when converting prices to ticks", () => {
    expect(exactTickFromUiPrice(1.0026, 6, 8)).toBeCloseTo(candlesToTickCandles(
      [{ time: 0, open: 1.0026, high: 1.0026, low: 1.0026, close: 1.0026, volume: 1 }],
      { decimalsA: 6, decimalsB: 8, feeRate: 0, currentExactTick: 0, rebase: false },
    )[0]!.lowTick, 6);
  });
});
