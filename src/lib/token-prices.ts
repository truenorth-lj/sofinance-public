import "server-only";

import { JUPITER_PRICE_TTL_MS, JUPITER_SOFT_RETRY, jupiterRequest } from "./jupiter";
import { JUPITER_PRICE_V3_PATH } from "./jupiter/urls";

const STABLE_USD_MINTS = new Set([
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
]);

export async function fetchJupiterPricesUsd(
  mints: string[],
  fetcher: typeof fetch = fetch,
  apiKey?: string,
): Promise<Map<string, number>> {
  const unique = [...new Set(mints.filter(Boolean))];
  const prices = new Map<string, number>();
  if (!unique.length) return prices;
  try {
    const body = await jupiterRequest<Record<string, { usdPrice?: number | string } | null>>({
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
      const raw = body[mint]?.usdPrice;
      const value = typeof raw === "number" ? raw : raw !== null && raw !== undefined ? Number(raw) : NaN;
      if (Number.isFinite(value) && value >= 0) prices.set(mint, value);
    }
  } catch {
    // Price fetch failed, return empty map
  }
  return prices;
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
