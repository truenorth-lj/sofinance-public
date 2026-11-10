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
/** Successful prices (and successful Jupiter omissions) cache for 10s, inside the 5–15s window. */
export const TOKEN_PRICE_TTL_MS = JUPITER_PRICE_TTL_MS;
/** Failed lookups are not cached, so the next call retries Jupiter instead of serving a stale miss. */
export const TOKEN_PRICE_FAILURE_TTL_MS = 0;
export const DEXSCREENER_SOLANA_TOKENS_URL = "https://api.dexscreener.com/tokens/v1/solana";
/** Ignore DexScreener pairs with missing, zero, or thin liquidity (below this USD floor). */
export const DEXSCREENER_MIN_LIQUIDITY_USD = 10_000;
/** Quote-side `priceNative` below this would explode `priceUsd / priceNative`. */
export const DEXSCREENER_MIN_PRICE_NATIVE = 1e-8;
export const DEXSCREENER_MIN_USD = 1e-8;
export const DEXSCREENER_MAX_USD = 1e9;

/** Keyless Jupiter Price API: 0.5 rps. Free-key plan: 1 rps. Both share one org bucket with other Jupiter calls. */
export const JUPITER_PRICE_KEYLESS_SPACING_MS = 2_000;
export const JUPITER_PRICE_KEYED_SPACING_MS = 1_000;
/** DexScreener documents 300 req/min (5 rps); stay a little under that. */
export const DEXSCREENER_PRICE_SPACING_MS = 220;

const PRICE_FETCH_TIMEOUT_MS = 5_000;

export type TokenPriceSource = "jupiter" | "dexscreener" | "raydium";
export type TokenPriceQuote = {
  price: number;
  source: TokenPriceSource;
  /** Optional Jupiter rolling 24h change; never inferred for fallback quotes. */
  priceChange24hPct?: number;
  liquidityUsd?: number;
};

type CachedMintPrice = { quote: TokenPriceQuote | undefined; expiresAt: number };

const mintCache = new Map<string, CachedMintPrice>();
const inflight = new Map<string, Promise<Map<string, TokenPriceQuote>>>();

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

function finiteMetadata(raw: unknown): number | undefined {
  const value = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() ? Number(raw) : NaN;
  return Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function tokenAddress(value: unknown): string | null {
  return isRecord(value) && typeof value.address === "string" ? value.address : null;
}

function cacheSet(mint: string, quote: TokenPriceQuote | undefined, ttlMs: number, now = Date.now()): void {
  if (ttlMs <= 0) return;
  mintCache.set(mint, { quote, expiresAt: now + ttlMs });
}

function deriveQuoteUsd(priceUsd: number, priceNativeRaw: unknown): number | null {
  const native = parseUsd(priceNativeRaw);
  if (native === null || native < DEXSCREENER_MIN_PRICE_NATIVE) return null;
  const derived = priceUsd / native;
  if (!Number.isFinite(derived) || derived < DEXSCREENER_MIN_USD || derived > DEXSCREENER_MAX_USD) return null;
  return derived;
}

/**
 * Pick a USD price for `mint` from a DexScreener `/tokens/v1/solana/{mints}` payload.
 *
 * Pairs with missing, zero, or sub-$10k `liquidity.usd` are ignored. Among the rest, pairs where
 * the mint is `baseToken` (use `priceUsd` directly) are preferred over quote-side pairs. Quote-side
 * prices are `priceUsd / priceNative` only when `priceNative` is at least `DEXSCREENER_MIN_PRICE_NATIVE`
 * and the result stays inside `[DEXSCREENER_MIN_USD, DEXSCREENER_MAX_USD]`. Same-class ties go to the
 * higher-liquidity pair. Solana addresses are compared as returned (base58, case-sensitive).
 */
export function pickDexScreenerUsdPrice(payload: unknown, mint: string): number | null {
  const pairs = Array.isArray(payload) ? payload : [];
  let best: { usd: number; liq: number; base: boolean } | null = null;
  for (const pair of pairs) {
    if (!isRecord(pair)) continue;
    const liqRaw = isRecord(pair.liquidity) ? Number(pair.liquidity.usd) : NaN;
    if (!Number.isFinite(liqRaw) || liqRaw < DEXSCREENER_MIN_LIQUIDITY_USD) continue;
    const priceUsd = parseUsd(pair.priceUsd);
    if (priceUsd === null) continue;
    const base = tokenAddress(pair.baseToken);
    const quote = tokenAddress(pair.quoteToken);
    let usd: number | null = null;
    let isBase = false;
    if (base === mint) {
      usd = priceUsd;
      isBase = true;
    } else if (quote === mint) {
      usd = deriveQuoteUsd(priceUsd, pair.priceNative);
    }
    if (usd === null) continue;
    if (!best || (isBase && !best.base) || (isBase === best.base && liqRaw > best.liq)) {
      best = { usd, liq: liqRaw, base: isBase };
    }
  }
  return best?.usd ?? null;
}

async function fetchJupiterPriceBatch(
  mints: string[],
  fetcher: typeof fetch,
  apiKey?: string,
): Promise<{ prices: Map<string, TokenPriceQuote>; failed: boolean }> {
  const prices = new Map<string, TokenPriceQuote>();
  try {
    activeJupiterApiKey = apiKey;
    const body = await jupiterPacer.pace(() => jupiterRequest<Record<string, { usdPrice?: number | string; priceChange24h?: unknown; liquidity?: unknown } | null>>({
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
      const row = body[mint];
      const value = parseUsd(row?.usdPrice, true);
      if (value !== null) {
        const quote: TokenPriceQuote = { price: value, source: "jupiter" };
        const change = finiteMetadata(row?.priceChange24h);
        const liquidity = finiteMetadata(row?.liquidity);
        if (change !== undefined) quote.priceChange24hPct = change;
        if (liquidity !== undefined) quote.liquidityUsd = liquidity;
        prices.set(mint, quote);
      }
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
): Promise<Map<string, TokenPriceQuote>> {
  const now = Date.now();
  const out = new Map<string, TokenPriceQuote>();
  const need: string[] = [];
  for (const mint of unique) {
    const hit = mintCache.get(mint);
    if (hit && hit.expiresAt > now) {
      if (hit.quote !== undefined) out.set(mint, hit.quote);
    } else {
      need.push(mint);
    }
  }
  if (!need.length) return out;

  const failedMints: string[] = [];
  for (const batch of chunks(need, JUPITER_PRICE_BATCH)) {
    const { prices, failed } = await fetchJupiterPriceBatch(batch, fetcher, apiKey);
    if (failed) {
      failedMints.push(...batch);
      continue;
    }
    for (const mint of batch) {
      const quote = prices.get(mint);
      if (quote !== undefined) {
        out.set(mint, quote);
        cacheSet(mint, quote, TOKEN_PRICE_TTL_MS);
      } else {
        // Jupiter answered but omitted this mint: leave it missing so Raydium pool-ratio fallbacks can run.
        cacheSet(mint, undefined, TOKEN_PRICE_TTL_MS);
      }
    }
  }

  for (const batch of chunks(failedMints, DEXSCREENER_PRICE_BATCH)) {
    const payload = await fetchDexScreenerPriceBatch(batch, fetcher);
    for (const mint of batch) {
      const value = pickDexScreenerUsdPrice(payload, mint);
      if (value !== null) {
        const quote = { price: value, source: "dexscreener" as const };
        out.set(mint, quote);
        cacheSet(mint, quote, TOKEN_PRICE_TTL_MS);
      }
      // Miss after a Jupiter request failure: do not cache (TOKEN_PRICE_FAILURE_TTL_MS = 0).
    }
  }
  return out;
}

/**
 * USD prices for Solana mints, with the source of each value.
 *
 * Primary: Jupiter Price API v3 (`GET /price/v3`, up to 50 ids). The optional key is exactly
 * `JUPITER_API_KEY` (or the `apiKey` argument, which server callers pass from `getJupiterApiKey()`).
 * It is sent as `x-api-key` and is server-side only: never `NEXT_PUBLIC_JUPITER_API_KEY`, and never
 * read in a client bundle. If the variable is unset or empty, the request is keyless (0.5 rps);
 * a free key raises the spacing to 1 rps. This module does not write Vercel env.
 *
 * DexScreener (`GET /tokens/v1/solana/{mints}`, up to 30 ids) is used only when the Jupiter request
 * itself fails (429, 5xx, timeout, network). A successful Jupiter response that omits a mint leaves
 * that mint missing — it is not filled from DexScreener. Pair pick: see `pickDexScreenerUsdPrice`.
 * Successful prices cache for 10s; failed lookups are not cached. Identical in-flight requests share
 * one promise. Never throws.
 */
export async function fetchTokenPricesUsd(
  mints: string[],
  fetcher: typeof fetch = fetch,
  apiKey?: string,
): Promise<Map<string, TokenPriceQuote>> {
  const unique = [...new Set(mints.filter(Boolean))];
  if (!unique.length) return new Map();
  const key = [...unique].sort().join(",");
  const existing = inflight.get(key);
  if (existing) return existing;
  const pending = loadTokenPricesUsd(unique, fetcher, apiKey).finally(() => inflight.delete(key));
  inflight.set(key, pending);
  return pending;
}

/** Same as `fetchTokenPricesUsd`, but returns only the numeric prices so existing callers stay unchanged. */
export async function fetchJupiterPricesUsd(
  mints: string[],
  fetcher: typeof fetch = fetch,
  apiKey?: string,
): Promise<Map<string, number>> {
  const quotes = await fetchTokenPricesUsd(mints, fetcher, apiKey);
  const prices = new Map<string, number>();
  for (const [mint, quote] of quotes) prices.set(mint, quote.price);
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
