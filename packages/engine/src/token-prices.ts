import { JUPITER_PRICE_TTL_MS, JUPITER_SOFT_RETRY, jupiterRequest } from "./jupiter";
import { JUPITER_PRICE_V3_PATH } from "./jupiter/urls";

const STABLE_USD_MINTS = new Set([
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
]);

/** One Jupiter Price v3 row: the USD price plus the fields the stock view reads (24h change, liquidity). */
export type JupiterPriceQuote = {
  usdPrice: number;
  /** Jupiter `priceChange24h`, in percent (rolling 24h of on-chain trading, not a US session). */
  priceChange24hPct: number | null;
  liquidityUsd: number | null;
};

const finiteNumber = (raw: unknown): number | null => {
  const value = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() ? Number(raw) : NaN;
  return Number.isFinite(value) ? value : null;
};

/** Jupiter Price v3 for `mints` in one call; a mint without a usable price is left out. Never throws. */
export async function fetchJupiterPriceQuotes(
  mints: string[],
  fetcher: typeof fetch = fetch,
  apiKey?: string,
): Promise<Map<string, JupiterPriceQuote>> {
  const unique = [...new Set(mints.filter(Boolean))];
  const quotes = new Map<string, JupiterPriceQuote>();
  if (!unique.length) return quotes;
  try {
    const body = await jupiterRequest<Record<string, { usdPrice?: unknown; priceChange24h?: unknown; liquidity?: unknown } | null>>({
      path: JUPITER_PRICE_V3_PATH,
      query: { ids: unique.join(",") },
      fetcher,
      apiKey,
      cacheKey: `price:${[...unique].sort().join(",")}`,
      cacheTtlMs: JUPITER_PRICE_TTL_MS,
      retry: JUPITER_SOFT_RETRY,
      signal: AbortSignal.timeout(5_000),
    });
    for (const mint of unique) {
      const row = body[mint];
      const usdPrice = finiteNumber(row?.usdPrice);
      if (usdPrice === null || usdPrice < 0) continue;
      quotes.set(mint, { usdPrice, priceChange24hPct: finiteNumber(row?.priceChange24h), liquidityUsd: finiteNumber(row?.liquidity) });
    }
  } catch {
    // Price fetch failed, return empty map
  }
  return quotes;
}

export async function fetchJupiterPricesUsd(
  mints: string[],
  fetcher: typeof fetch = fetch,
  apiKey?: string,
): Promise<Map<string, number>> {
  const quotes = await fetchJupiterPriceQuotes(mints, fetcher, apiKey);
  return new Map([...quotes].map(([mint, quote]) => [mint, quote.usdPrice]));
}

export async function fetchRaydiumPoolUsdPrices(
  poolId: string,
  mintA: string,
  mintB: string,
  fetcher: typeof fetch = fetch,
): Promise<Map<string, number>> {
  const prices = new Map<string, number>();
  const url = `https://api-v3.raydium.io/pools/info/ids?ids=${encodeURIComponent(poolId)}`;
  try {
    const response = await fetcher(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(5_000) });
    if (!response.ok) return prices;
    const body = (await response.json()) as { data?: Array<{ price?: number | string } | null> };
    const pool = body.data?.[0];
    const ratio = pool?.price !== null && pool?.price !== undefined ? Number(pool.price) : NaN;
    if (!Number.isFinite(ratio) || ratio <= 0) return prices;
    if (STABLE_USD_MINTS.has(mintB)) {
      prices.set(mintB, 1);
      prices.set(mintA, ratio);
    } else if (STABLE_USD_MINTS.has(mintA)) {
      prices.set(mintA, 1);
      prices.set(mintB, 1 / ratio);
    }
  } catch {
    // Price fetch failed, return empty map
  }
  return prices;
}
