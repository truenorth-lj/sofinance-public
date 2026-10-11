/**
 * GeckoTerminal hourly OHLCV (`currency=token`) parsing and orientation (pure).
 * With `currency=token` the candle prices are QUOTE-per-BASE of the pool as Gecko lists it and the
 * volume column is in quote-token units, so only its relative size is used (USD volume comes from the
 * daily series). Raydium's A/B order can be the reverse of Gecko's base/quote: `orientCandles` fixes it.
 */
export type RawCandle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type GeckoHourlyCandles = {
  baseAddress: string | null;
  quoteAddress: string | null;
  candles: RawCandle[];
};

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function parseGeckoHourlyCandles(body: unknown): GeckoHourlyCandles {
  const empty: GeckoHourlyCandles = { baseAddress: null, quoteAddress: null, candles: [] };
  if (!body || typeof body !== "object" || Array.isArray(body)) return empty;
  const record = body as {
    data?: { attributes?: { ohlcv_list?: unknown } };
    meta?: { base?: { address?: unknown }; quote?: { address?: unknown } };
  };
  const list = record.data?.attributes?.ohlcv_list;
  if (!Array.isArray(list)) return empty;
  const candles: RawCandle[] = [];
  for (const row of list) {
    if (!Array.isArray(row) || row.length < 6) continue;
    const time = finite(row[0]);
    const open = finite(row[1]);
    const high = finite(row[2]);
    const low = finite(row[3]);
    const close = finite(row[4]);
    const volume = finite(row[5]);
    if (time === null || open === null || high === null || low === null || close === null || volume === null) continue;
    if (low <= 0 || high < low || volume < 0) continue;
    candles.push({ time, open, high, low, close, volume });
  }
  candles.sort((left, right) => left.time - right.time);
  const address = (value: unknown) => (typeof value === "string" ? value : null);
  return {
    baseAddress: address(record.meta?.base?.address),
    quoteAddress: address(record.meta?.quote?.address),
    candles,
  };
}

/**
 * Express candle prices as "B per 1 A" of the Raydium pool. Gecko's base is Raydium's A when
 * `baseAddress === mintA` (price already B per A); when base is B the price is A per B and is inverted.
 * Returns null when the pool's tokens cannot be matched.
 */
export function orientCandles(
  parsed: GeckoHourlyCandles, mintA: string, mintB: string,
): RawCandle[] | null {
  if (parsed.baseAddress === mintA && parsed.quoteAddress === mintB) return parsed.candles;
  if (parsed.baseAddress === mintB && parsed.quoteAddress === mintA) {
    return parsed.candles.map((candle) => ({
      ...candle,
      open: 1 / candle.open, close: 1 / candle.close, high: 1 / candle.low, low: 1 / candle.high,
    }));
  }
  return null;
}
