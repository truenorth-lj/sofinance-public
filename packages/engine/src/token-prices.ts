import { JUPITER_PRICE_TTL_MS, jupiterRequest } from "./jupiter";
import { JUPITER_PRICE_V3_PATH, resolveJupiterApiKey } from "./jupiter/urls";

const STABLE_USD_MINTS = new Set([
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
]);

/** Jupiter Price API v3 accepts at most 50 mint ids per request. */
export const JUPITER_PRICE_BATCH = 50;
/** DexScreener `GET /tokens/v1/{chain}/{mints}` accepts at most 30 addresses per request. */
export const DEXSCREENER_PRICE_BATCH = 30;
/** Shared 10s TTL (inside the 5–15s window) for Jupiter hits, DexScreener fallbacks, and known misses. */
export const TOKEN_PRICE_TTL_MS = JUPITER_PRICE_TTL_MS;
export const DEXSCREENER_SOLANA_TOKENS_URL = "https://api.dexscreener.com/tokens/v1/solana";

/** Keyless Jupiter Price API: 0.5 rps. Free-key plan: 1 rps. Both share one org bucket with other Jupiter calls. */
export const JUPITER_PRICE_KEYLESS_SPACING_MS = 2_000;
export const JUPITER_PRICE_KEYED_SPACING_MS = 1_000;
/** DexScreener documents 300 req/min (5 rps); stay a little under that. */
export const DEXSCREENER_PRICE_SPACING_MS = 220;

const PRICE_FETCH_TIMEOUT_MS = 5_000;

type CachedMintPrice = { value: number | undefined; expiresAt: number };

const mintCache = new Map<string, CachedMintPrice>();
const inflight = new Map<string, Promise<Map<string, number>>>();

type Pacer = { pace: <T>(run: () => Promise<T>) => Promise<T>; reset: () => void };

function createPacer(spacingOf: () => number): Pacer {
  let lastAt = 0;
  let queue: Promise<unknown> = Promise.resolve();
  return {
    reset() { lastAt = 0; queue = Promise.resolve(); },
    pace<T>(run: () => Promise<T>): Promise<T> {
      const started = queue.then(async () => {
        const wait = lastAt + spacingOf() - Date.now();
        if (wait > 0) await new Promise<void>((resolve) => setTimeout(resolve, wait));
        try { return await run(); } finally { lastAt = Date.now(); }
      });
      queue = started.catch(() => undefined);
      return started;
    },
  };
}

let jupiterSpacingMs: number | "auto" = "auto";
let dexScreenerSpacingMs: number | "auto" = "auto";
let activeJupiterApiKey: string | undefined;

const jupiterPacer = createPacer(() => {
  if (jupiterSpacingMs !== "auto") return jupiterSpacingMs;
  return resolveJupiterApiKey(activeJupiterApiKey) ? JUPITER_PRICE_KEYED_SPACING_MS : JUPITER_PRICE_KEYLESS_SPACING_MS;
});
const dexScreenerPacer = createPacer(() => (
  dexScreenerSpacingMs === "auto" ? DEXSCREENER_PRICE_SPACING_MS : dexScreenerSpacingMs
));

export function resetTokenPriceRuntime(options: { jupiterSpacingMs?: number; dexScreenerSpacingMs?: number } = {}): void {
  mintCache.clear();
  inflight.clear();
  jupiterPacer.reset();
  dexScreenerPacer.reset();
  jupiterSpacingMs = options.jupiterSpacingMs ?? "auto";
  dexScreenerSpacingMs = options.dexScreenerSpacingMs ?? "auto";
  activeJupiterApiKey = undefined;
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size) as T[]);
  return out;
}

function parseUsd(raw: unknown, allowZero = false): number | null {
  const value = typeof raw === "number" ? raw : raw !== null && raw !== undefined && raw !== "" ? Number(raw) : NaN;
  if (!Number.isFinite(value)) return null;
  if (allowZero ? value < 0 : value <= 0) return null;
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function tokenAddress(value: unknown): string | null {
  return isRecord(value) && typeof value.address === "string" ? value.address : null;
}

function cacheSet(mint: string, value: number | undefined, now = Date.now()): void {
  mintCache.set(mint, { value, expiresAt: now + TOKEN_PRICE_TTL_MS });
}

/**
 * Pick a USD price for `mint` from a DexScreener `/tokens/v1/solana/{mints}` payload.
 *
 * Among pairs that include the mint and yield a positive finite USD price, choose the highest
 * `liquidity.usd` (missing liquidity counts as 0). If the mint is the pair's `baseToken`, use
 * `priceUsd` directly. If it is the `quoteToken`, derive `priceUsd / priceNative` (base USD
 * divided by base-priced-in-quote). Solana addresses are compared as returned (base58, case-sensitive).
 */
export function pickDexScreenerUsdPrice(payload: unknown, mint: string): number | null {
  const pairs = Array.isArray(payload) ? payload : [];
  let best: { usd: number; liq: number } | null = null;
  for (const pair of pairs) {
    if (!isRecord(pair)) continue;
    const priceUsd = parseUsd(pair.priceUsd);
    if (priceUsd === null) continue;
    const base = tokenAddress(pair.baseToken);
    const quote = tokenAddress(pair.quoteToken);
    let usd: number | null = null;
    if (base === mint) usd = priceUsd;
    else if (quote === mint) {
      const native = parseUsd(pair.priceNative);
      if (native !== null) usd = priceUsd / native;
    }
    if (usd === null || !Number.isFinite(usd) || usd <= 0) continue;
    const liqRaw = isRecord(pair.liquidity) ? Number(pair.liquidity.usd) : NaN;
    const liq = Number.isFinite(liqRaw) && liqRaw > 0 ? liqRaw : 0;
    if (!best || liq > best.liq) best = { usd, liq };
  }
  return best?.usd ?? null;
}

async function fetchJupiterPriceBatch(
  mints: string[],
  fetcher: typeof fetch,
  apiKey?: string,
): Promise<{ prices: Map<string, number>; failed: boolean }> {
  const prices = new Map<string, number>();
  try {
    activeJupiterApiKey = apiKey;
    const body = await jupiterPacer.pace(() => jupiterRequest<Record<string, { usdPrice?: number | string } | null>>({
      path: JUPITER_PRICE_V3_PATH,
      query: { ids: mints.join(",") },
      fetcher,
      apiKey,
      cacheKey: `price:${[...mints].sort().join(",")}`,
      cacheTtlMs: TOKEN_PRICE_TTL_MS,
      // One attempt: 429 / 5xx / timeout fall through to DexScreener instead of spending more of the shared quota.
      retry: { maxAttempts: 1, budgetMs: PRICE_FETCH_TIMEOUT_MS },
      signal: AbortSignal.timeout(PRICE_FETCH_TIMEOUT_MS),
    }));
    for (const mint of mints) {
      const value = parseUsd(body[mint]?.usdPrice, true);
      if (value !== null) prices.set(mint, value);
    }
    return { prices, failed: false };
  } catch {
    return { prices, failed: true };
  }
}

async function fetchDexScreenerPriceBatch(mints: string[], fetcher: typeof fetch): Promise<unknown> {
  const url = `${DEXSCREENER_SOLANA_TOKENS_URL}/${mints.join(",")}`;
  try {
    const response = await dexScreenerPacer.pace(() => fetcher(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(PRICE_FETCH_TIMEOUT_MS),
    }));
    if (!response || typeof response.ok !== "boolean" || !response.ok) return [];
    return await response.json();
  } catch {
    return [];
  }
}

async function loadTokenPricesUsd(
  unique: string[],
  fetcher: typeof fetch,
  apiKey?: string,
): Promise<Map<string, number>> {
  const now = Date.now();
  const out = new Map<string, number>();
  const need: string[] = [];
  for (const mint of unique) {
    const hit = mintCache.get(mint);
    if (hit && hit.expiresAt > now) {
      if (hit.value !== undefined) out.set(mint, hit.value);
    } else {
      need.push(mint);
    }
  }
  if (!need.length) return out;

  const missing: string[] = [];
  for (const batch of chunks(need, JUPITER_PRICE_BATCH)) {
    const { prices, failed } = await fetchJupiterPriceBatch(batch, fetcher, apiKey);
    for (const mint of batch) {
      const value = prices.get(mint);
      if (value !== undefined) {
        out.set(mint, value);
        cacheSet(mint, value);
      } else if (failed || !prices.has(mint)) {
        missing.push(mint);
      }
    }
  }

  for (const batch of chunks(missing, DEXSCREENER_PRICE_BATCH)) {
    const payload = await fetchDexScreenerPriceBatch(batch, fetcher);
    for (const mint of batch) {
      const value = pickDexScreenerUsdPrice(payload, mint);
      if (value !== null) {
        out.set(mint, value);
        cacheSet(mint, value);
      } else {
        cacheSet(mint, undefined);
      }
    }
  }
  return out;
}

/**
 * USD prices for Solana mints.
 *
 * Primary: Jupiter Price API v3 (`GET /price/v3`, up to 50 ids). The optional key is exactly
 * `JUPITER_API_KEY` (or the `apiKey` argument, which server callers pass from `getJupiterApiKey()`).
 * It is sent as `x-api-key` and is server-side only: never `NEXT_PUBLIC_JUPITER_API_KEY`, and never
 * read in a client bundle. If the variable is unset or empty, the request is keyless (0.5 rps);
 * a free key raises the spacing to 1 rps. This module does not write Vercel env. On a Jupiter 429
 * or other error, or when a mint is omitted (no reliable trade in 7 days), each missing mint falls
 * back to DexScreener `GET /tokens/v1/solana/{mints}` (up to 30 ids) and the highest-liquidity pair
 * that yields a USD price (see `pickDexScreenerUsdPrice`). Prices and known misses cache for 10s;
 * identical in-flight requests share one promise. Callers that already treat a missing mint as
 * "unknown price" keep that behavior when both sources omit it. Never throws.
 */
export async function fetchJupiterPricesUsd(
  mints: string[],
  fetcher: typeof fetch = fetch,
  apiKey?: string,
): Promise<Map<string, number>> {
  const unique = [...new Set(mints.filter(Boolean))];
  if (!unique.length) return new Map();
  const key = [...unique].sort().join(",");
  const existing = inflight.get(key);
  if (existing) return existing;
  const pending = loadTokenPricesUsd(unique, fetcher, apiKey).finally(() => inflight.delete(key));
  inflight.set(key, pending);
  return pending;
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
