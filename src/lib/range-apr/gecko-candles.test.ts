import { describe, expect, it } from "vitest";
import { orientCandles, parseGeckoHourlyCandles } from "./gecko-candles";

const A = "MintA111111111111111111111111111111111111111";
const B = "MintB111111111111111111111111111111111111111";

function body(list: unknown, base = A, quote = B) {
  return { data: { attributes: { ohlcv_list: list } }, meta: { base: { address: base }, quote: { address: quote } } };
}

describe("parseGeckoHourlyCandles", () => {
  it("parses [time, open, high, low, close, volume] rows, sorted ascending, with the pool orientation", () => {
    const parsed = parseGeckoHourlyCandles(body([[7200, 1, 1.2, 0.9, 1.1, 5], [3600, 1, 1, 1, 1, 2]]));
    expect(parsed.baseAddress).toBe(A);
    expect(parsed.quoteAddress).toBe(B);
    expect(parsed.candles.map((candle) => candle.time)).toEqual([3600, 7200]);
    expect(parsed.candles[1]).toEqual({ time: 7200, open: 1, high: 1.2, low: 0.9, close: 1.1, volume: 5 });
  });

  it("drops malformed, non-positive and inverted rows", () => {
    const parsed = parseGeckoHourlyCandles(body([
      [1, 1, 1, 1, 1], [2, "x", 1, 1, 1, 1], [3, 1, 1, 0, 1, 1], [4, 1, 0.5, 1, 1, 1], [5, 1, 1, 1, 1, -1], [6, 1, 1, 1, 1, 1],
    ]));
    expect(parsed.candles.map((candle) => candle.time)).toEqual([6]);
  });

  it("is empty for unexpected bodies", () => {
    expect(parseGeckoHourlyCandles(null).candles).toEqual([]);
    expect(parseGeckoHourlyCandles([]).candles).toEqual([]);
    expect(parseGeckoHourlyCandles({ data: {} }).candles).toEqual([]);
  });
});

describe("orientCandles", () => {
  const candles = parseGeckoHourlyCandles(body([[3600, 2, 4, 1, 2, 9]]));

  it("keeps prices when Gecko's base is the pool's A token", () => {
    expect(orientCandles(candles, A, B)).toEqual(candles.candles);
  });

  it("inverts prices and swaps high/low when Gecko's base is the pool's B token", () => {
    const [flipped] = orientCandles(candles, B, A)!;
    expect(flipped).toEqual({ time: 3600, open: 0.5, high: 1, low: 0.25, close: 0.5, volume: 9 });
  });

  it("returns null when the tokens do not match the pool", () => {
    expect(orientCandles(candles, A, "other")).toBeNull();
    expect(orientCandles(parseGeckoHourlyCandles(null), A, B)).toBeNull();
  });
});
