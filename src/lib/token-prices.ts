import "server-only";

const JUPITER_PRICE_V3 = "https://api.jup.ag/price/v3";
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
  const url = new URL(JUPITER_PRICE_V3);
  url.searchParams.set("ids", unique.join(","));
  const headers: Record<string, string> = { Accept: "application/json" };
  if (apiKey) headers["x-api-key"] = apiKey;
  try {
    const response = await fetcher(url.toString(), { headers, signal: AbortSignal.timeout(5_000) });
    if (!response.ok) return prices;
    const body = (await response.json()) as Record<string, { usdPrice?: number | string } | null>;
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
