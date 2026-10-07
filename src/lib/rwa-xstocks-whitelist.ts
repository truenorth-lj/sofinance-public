import "server-only";

/**
 * Backed xStocks public assets whitelist (Solana deployment mints).
 * Secondary qualifier when Jupiter tags lag.
 * Paginated GET https://api.xstocks.fi/api/v2/public/assets
 */

export const XSTOCKS_ASSETS_API = "https://api.xstocks.fi/api/v2/public/assets";
const PAGE_LIMIT = 100;
const MAX_PAGES = 40;
const CACHE_TTL_MS = 30 * 60_000;

type CacheEntry = { expiresAt: number; mints: Set<string> };
let cache: CacheEntry | null = null;

export type FetchXstocksWhitelistOptions = {
  fetcher?: typeof fetch;
  bypassCache?: boolean;
};

/**
 * Return the set of Solana mint addresses published by Backed xStocks.
 */
export async function fetchXstocksSolanaMintSet(
  options: FetchXstocksWhitelistOptions = {},
): Promise<Set<string>> {
  const now = Date.now();
  if (!options.bypassCache && cache && cache.expiresAt > now) {
    return cache.mints;
  }

  const fetcher = options.fetcher ?? fetch;
  const mints = new Set<string>();

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const url = new URL(XSTOCKS_ASSETS_API);
    url.searchParams.set("page", String(page));
    url.searchParams.set("limit", String(PAGE_LIMIT));

    const response = await fetcher(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": "SoFinance/0.1 (RWA pair discovery; +https://github.com/truenorth-lj/sofinance-public)",
      },
      signal: AbortSignal.timeout(45_000),
    });
    if (!response.ok) {
      throw new Error(`xStocks assets list failed (${response.status})`);
    }
    const body: unknown = await response.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new Error("xStocks assets list returned unexpected payload");
    }
    const envelope = body as { nodes?: unknown; page?: { hasNextPage?: unknown } };
    const nodes = Array.isArray(envelope.nodes) ? envelope.nodes : [];
    for (const node of nodes) {
      if (!node || typeof node !== "object" || Array.isArray(node)) continue;
      const deployments = (node as { deployments?: unknown }).deployments;
      if (!Array.isArray(deployments)) continue;
      for (const dep of deployments) {
        if (!dep || typeof dep !== "object" || Array.isArray(dep)) continue;
        const network = (dep as { network?: unknown }).network;
        const address = (dep as { address?: unknown }).address;
        if (network === "Solana" && typeof address === "string" && address.length > 0) {
          mints.add(address);
        }
      }
    }
    if (envelope.page?.hasNextPage !== true || nodes.length === 0) break;
  }

  cache = { expiresAt: now + CACHE_TTL_MS, mints };
  return mints;
}

/** Test helper to clear the module cache. */
export function clearXstocksWhitelistCache() {
  cache = null;
}
