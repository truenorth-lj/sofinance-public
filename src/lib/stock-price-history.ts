import "server-only";
/**
 * Past prices of a stock token for the Performance stock view, from CoinGecko by Solana token address: daily closes
 * (entry price on each deposit day, since-entry line) and hourly prices over the last day (24h line).
 *
 * Why CoinGecko: Jupiter's public API has the current price and changes over at most 24h, nothing older; GeckoTerminal
 * is reserved for the pool scan and must not be called on a position read (DEX contract, `FORBIDDEN_READ_HOSTS`);
 * Pyth's history API needs a key whose terms are not published. CoinGecko lists every xStock (one year of daily
 * history) and the other issuers' tokens since their listing.
 *
 * Key: `COINGECKO_API_KEY` (a free Demo key: 10,000 calls/month, 100/min, one year of history), sent as
 * `x-cg-demo-api-key`. Without it the keyless public API is used (lower, shared-IP limits).
 * Budget: per stock token, at most one daily read per 12 h and one hourly read per 3 h on each server instance, one
 * call at a time, and a cooldown after a 429. Failures return null and never throw.
 */
import { ThrottleGate } from "./range-apr/throttle-gate";
import type { PriceClose } from "./stock-performance";

export const COINGECKO_API = "https://api.coingecko.com/api/v3";
const DAY = 86_400;
const DAILY_TTL_MS = 12 * 60 * 60_000;
/** 3 h: 16 stocks × (2 daily + 8 hourly) = 160 calls/day per instance at most, well inside the Demo plan's 10,000/month.
 * The 24h line still ends at the live Jupiter price (`computeStockPerformance`). */
const HOURLY_TTL_MS = 3 * 60 * 60_000;
const FAILURE_TTL_MS = 5 * 60_000;
const TIMEOUT_MS = 6_000;

export type StockPriceHistory = { daily: PriceClose[]; hourly: PriceClose[]; source: string };

type Cached<T> = { value: T; expiresAt: number };
const dailyCache = new Map<string, Cached<PriceClose[] | null>>();
const hourlyCache = new Map<string, Cached<PriceClose[] | null>>();
const gate = new ThrottleGate({ minSpacingMs: 700, defaultCooldownMs: 60_000, maxCooldownMs: 120_000 });

/** Test hook: forget every cached read. */
export function resetStockPriceHistoryCache() {
  dailyCache.clear();
  hourlyCache.clear();
}

export function coinGeckoApiKey(): string | undefined {
  return process.env.COINGECKO_API_KEY?.trim() || undefined;
}

/** `[[ms, price], …]` from a market_chart body, oldest first; bad rows dropped. */
function parsePrices(body: unknown): Array<{ ms: number; price: number }> {
  const prices = (body as { prices?: unknown })?.prices;
  if (!Array.isArray(prices)) return [];
  const rows: Array<{ ms: number; price: number }> = [];
  for (const row of prices) {
    if (!Array.isArray(row)) continue;
    const ms = Number(row[0]);
    const price = Number(row[1]);
    if (Number.isFinite(ms) && Number.isFinite(price) && price > 0) rows.push({ ms, price });
  }
  return rows.sort((a, b) => a.ms - b.ms);
}

/**
 * Daily market_chart points as daily closes. CoinGecko stamps a daily point at 00:00 UTC with the price at that
 * moment, which is the close of the day before; the last point is "now" (today's close so far). Each point is keyed
 * to the UTC day it closes, and a later point for the same day wins.
 */
export function parseDailyCloses(body: unknown): PriceClose[] {
  const byDay = new Map<number, number>();
  for (const { ms, price } of parsePrices(body)) byDay.set(Math.floor((ms / 1000 - 1) / DAY) * DAY, price);
  return [...byDay].map(([time, close]) => ({ time, close })).sort((a, b) => a.time - b.time);
}

/** Hourly market_chart points as they are (`time` is the point's own time). */
export function parseHourlyPrices(body: unknown): PriceClose[] {
  return parsePrices(body).map(({ ms, price }) => ({ time: Math.floor(ms / 1000), close: price }));
}

async function marketChart(mint: string, query: string, fetcher: typeof fetch, signal?: AbortSignal): Promise<unknown> {
  const key = coinGeckoApiKey();
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const run = await gate.run(async () => {
    const response = await fetcher(`${COINGECKO_API}/coins/solana/contract/${mint}/market_chart?vs_currency=usd&${query}`, {
      headers: { Accept: "application/json", "User-Agent": "SoFinance/0.1 (position performance; +https://sofinancelab.xyz)",
        ...(key ? { "x-cg-demo-api-key": key } : {}) },
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (response.status === 429) {
      const retryAfter = Number(response.headers.get("retry-after"));
      gate.block(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined);
    }
    if (!response.ok) throw new Error(`CoinGecko ${response.status}`);
    return response.json() as Promise<unknown>;
  });
  if ("blocked" in run) throw new Error("CoinGecko is cooling down after a 429");
  return run.value;
}

async function cached<T>(cache: Map<string, Cached<T | null>>, key: string, ttlMs: number, read: () => Promise<T | null>): Promise<T | null> {
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.value;
  try {
    const value = await read();
    cache.set(key, { value, expiresAt: Date.now() + (value === null ? FAILURE_TTL_MS : ttlMs) });
    return value;
  } catch {
    cache.set(key, { value: null, expiresAt: Date.now() + FAILURE_TTL_MS });
    return null;
  }
}

/** Past prices for the first of `mints` CoinGecko has daily prices for. */
export async function loadStockPriceHistory(mints: string[], options: { fetcher?: typeof fetch; signal?: AbortSignal } = {}): Promise<StockPriceHistory | null> {
  const fetcher = options.fetcher ?? fetch;
  for (const mint of [...new Set(mints.filter(Boolean))]) {
    const daily = await cached(dailyCache, mint, DAILY_TTL_MS, async () => {
      const closes = parseDailyCloses(await marketChart(mint, "days=365&interval=daily", fetcher, options.signal));
      return closes.length ? closes : null;
    });
    if (!daily) continue;
    // days=2 is CoinGecko's hourly granularity (days=1 would be 5-minutely).
    const hourly = await cached(hourlyCache, mint, HOURLY_TTL_MS, async () =>
      parseHourlyPrices(await marketChart(mint, "days=2", fetcher, options.signal)));
    return { daily, hourly: hourly ?? [], source: "CoinGecko daily price" };
  }
  return null;
}
