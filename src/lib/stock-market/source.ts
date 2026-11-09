import "@/lib/engine-host";
import "server-only";
/**
 * Server-side data for the homepage stock cards and the spot swap (cached; never per visitor).
 *
 * Jupiter budget (free tier, 1 request/s per org): a full refresh is ONE pass over the fixed universe through the
 * Jupiter Tokens V2 search endpoint with up to 100 comma-separated mints per call: 218 mints = 3 calls, spaced at
 * least 1.1 s apart. Buy eligibility adds one Jupiter quote probe (1 USDC) per shown stock whose cached probe result
 * is older than 30 minutes (usually 0, at most one per shown stock) plus one RPC `getMultipleAccounts`.
 * Both results sit in the Next data cache for 10 minutes; a failed read throws and is never cached.
 * CoinGecko is not called here (cross-check only, offline).
 */
import { unstable_cache } from "next/cache";
import { rpcConnection, RpcUnavailableError } from "@sofinance/engine/rpc";
import { jupiterRequest } from "@sofinance/engine/jupiter";
import { JUPITER_TOKENS_SEARCH_PATH } from "@sofinance/engine/jupiter/urls";
import { getJupiterApiKey } from "@sofinance/engine/config/server-env";
import { trustedIcon } from "@sofinance/engine/token-metadata";
import { spotSwapRouteCheck, type SpotSwapRouteCheck } from "@sofinance/engine/spot-swap";
import { PublicKey } from "@solana/web3.js";
import { upstreamUnavailable } from "@/lib/upstream-errors";
import { buildStockMarket, displayedUnderlyings, parseJupiterStockRow, type JupiterStockRow, type StockMarket } from "./build";
import { computeStockBuyEligibility, spotSwapAllowlistFor, type SpotSwapStockContext, type StockBuyEligibility } from "./buy";
import { STOCK_UNIVERSE } from "./universe";

export const STOCK_MARKET_REVALIDATE_SECONDS = 600;
export const STOCK_SEARCH_BATCH = 100;
/** Minimum spacing between this module's Jupiter calls (free tier: 1 request/s per org). */
export const STOCK_JUPITER_SPACING_MS = 1_100;
export const STOCK_ROUTE_PROBE_TTL_MS = 30 * 60_000;
const SEARCH_TIMEOUT_MS = 15_000;

let lastJupiterCallAt = 0;
async function paced<T>(call: () => Promise<T>): Promise<T> {
  const wait = lastJupiterCallAt + STOCK_JUPITER_SPACING_MS - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastJupiterCallAt = Date.now();
  try { return await call(); } finally { lastJupiterCallAt = Date.now(); }
}

/** The universe's Jupiter rows: ceil(218 / 100) = 3 search calls, one at a time. */
export async function fetchJupiterStockRows(options: { fetcher?: typeof fetch } = {}): Promise<JupiterStockRow[]> {
  const mints = STOCK_UNIVERSE.map(([mint]) => mint);
  const rows: JupiterStockRow[] = [];
  for (let i = 0; i < mints.length; i += STOCK_SEARCH_BATCH) {
    const batch = mints.slice(i, i + STOCK_SEARCH_BATCH);
    const body: unknown = await paced(() => jupiterRequest({
      path: JUPITER_TOKENS_SEARCH_PATH, query: { query: batch.join(",") }, fetcher: options.fetcher, apiKey: getJupiterApiKey(),
      headers: { "User-Agent": "SoFinance/0.1 (stock cards; +https://sofinancelab.xyz)" },
      cacheKey: null, signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    }));
    if (!Array.isArray(body)) throw new Error("Jupiter tokens search returned an unexpected payload");
    const requested = new Set(batch);
    for (const raw of body) {
      const row = parseJupiterStockRow(raw);
      if (row && requested.has(row.id)) rows.push(row);
    }
  }
  return rows;
}

async function readStockMarket(): Promise<StockMarket> {
  const market = buildStockMarket(await fetchJupiterStockRows(), { icon: trustedIcon });
  if (!market.gainers.length && !market.stocks.length) throw new Error("No stock passed the filters"); // never cache an empty read
  return market;
}

export const loadStockMarket = unstable_cache(readStockMarket, ["stock-market-v2"], {
  revalidate: STOCK_MARKET_REVALIDATE_SECONDS, tags: ["stock-market"],
});

const probes = new Map<string, { result: SpotSwapRouteCheck; expiresAt: number }>();
async function cachedRouteCheck(mint: string, usdcRaw: bigint): Promise<SpotSwapRouteCheck> {
  const key = `${mint}:${usdcRaw}`;
  const hit = probes.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.result;
  const result = await paced(() => spotSwapRouteCheck(mint, usdcRaw));
  probes.set(key, { result, expiresAt: Date.now() + STOCK_ROUTE_PROBE_TTL_MS });
  return result;
}

/** An outage (Jupiter 429/5xx/timeout, RPC down): rethrown so it is never cached as "not buyable". */
export function isStockSourceUnavailable(error: unknown): boolean {
  if (upstreamUnavailable(error)) return true;
  if (error instanceof RpcUnavailableError) return true;
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}

async function readStockBuyEligibility(underlyings: string[]): Promise<StockBuyEligibility> {
  const market = await loadStockMarket();
  const connection = rpcConnection();
  return computeStockBuyEligibility(market, underlyings, {
    readMints: (mints) => connection.getMultipleAccountsInfo(mints.map((mint) => new PublicKey(mint)), "confirmed"),
    checkRoute: cachedRouteCheck,
    isUnavailable: isStockSourceUnavailable,
  });
}

const cachedEligibility = unstable_cache(readStockBuyEligibility, ["stock-buy-eligibility-v1"], {
  revalidate: STOCK_MARKET_REVALIDATE_SECONDS, tags: ["stock-market"],
});

/** Buy eligibility for every stock shown on the cards (same key as the homepage, so routes reuse its cache). */
export async function loadStockBuyEligibility(market: StockMarket): Promise<StockBuyEligibility> {
  return cachedEligibility(displayedUnderlyings(market));
}


/**
 * Server-side allowlist for one stock row, rebuilt from the cached market + eligibility (client metadata is never
 * trusted). Null when the row has no Buy. Call this OUTSIDE `withJupiterRelay`: a cache miss calls Jupiter search.
 */
export async function loadSpotSwapStockContext(underlying: string): Promise<SpotSwapStockContext | null> {
  const market = await loadStockMarket();
  const eligibility = await loadStockBuyEligibility(market);
  if (!eligibility.options[underlying]) return null;
  const candidates = eligibility.candidates[underlying] ?? [];
  return candidates.length ? { underlying, candidates } : null;
}

export { spotSwapAllowlistFor };
export type { SpotSwapStockContext };
