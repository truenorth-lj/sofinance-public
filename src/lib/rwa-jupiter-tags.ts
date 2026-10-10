import "server-only";

/**
 * Jupiter Tokens API v2 mint → tags cache for RWA discovery.
 * GET /tokens/v2/search?query={mint[,mint...]} through the shared Jupiter client.
 * Sends x-api-key from JUPITER_API_KEY when present; never logs the key.
 */

import { jupiterRequest } from "./jupiter";
import { JUPITER_TOKENS_SEARCH, JUPITER_TOKENS_SEARCH_PATH } from "./jupiter/urls";

export { JUPITER_TOKENS_SEARCH };

const BATCH_SIZE = 100;
const CACHE_TTL_MS = 10 * 60_000;

type CacheEntry = { expiresAt: number; tagsByMint: Map<string, string[]> };
let cache: CacheEntry | null = null;

export type FetchJupiterTagsOptions = {
  fetcher?: typeof fetch;
  apiKey?: string | undefined;
  /** Skip module cache (tests). */
  bypassCache?: boolean;
};

function parseTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((t): t is string => typeof t === "string" && t.trim() !== "");
}

/**
 * Resolve Jupiter `tags` for the given mint addresses (batched, cached).
 * Missing mints are omitted from the map (treated as untagged by callers).
 */
export async function fetchJupiterTagsByMint(
  mints: string[],
  options: FetchJupiterTagsOptions = {},
): Promise<Map<string, string[]>> {
  const unique = [...new Set(mints.filter((m) => typeof m === "string" && m.length > 0))];
  const result = new Map<string, string[]>();
  if (unique.length === 0) return result;

  const now = Date.now();
  const useCache = !options.bypassCache && cache && cache.expiresAt > now;
  const pending: string[] = [];
  for (const mint of unique) {
    if (useCache && cache!.tagsByMint.has(mint)) {
      result.set(mint, cache!.tagsByMint.get(mint)!);
    } else {
      pending.push(mint);
    }
  }
  if (pending.length === 0) return result;

  const fetcher = options.fetcher ?? fetch;
  const apiKey = options.apiKey ?? process.env.JUPITER_API_KEY;
  const fetched = new Map<string, string[]>();

  for (let i = 0; i < pending.length; i += BATCH_SIZE) {
    const batch = pending.slice(i, i + BATCH_SIZE);
    const body: unknown = await jupiterRequest({
      path: JUPITER_TOKENS_SEARCH_PATH,
      query: { query: batch.join(",") },
      fetcher,
      apiKey,
      headers: {
        "User-Agent": "SoFinance/0.1 (RWA pair discovery; +https://github.com/truenorth-lj/sofinance-public)",
      },
      cacheKey: `tokens:${batch.join(",")}`,
      cacheTtlMs: CACHE_TTL_MS,
      signal: AbortSignal.timeout(20_000),
    });
    if (!Array.isArray(body)) {
      throw new Error("Jupiter tokens search returned unexpected payload");
    }
    const requested = new Set(batch);
    for (const raw of body) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const row = raw as { id?: unknown; tags?: unknown };
      if (typeof row.id !== "string" || !requested.has(row.id)) continue;
      fetched.set(row.id, parseTags(row.tags));
    }
  }

  const nextMap = useCache ? new Map(cache!.tagsByMint) : new Map<string, string[]>();
  for (const [mint, tags] of fetched) {
    nextMap.set(mint, tags);
    result.set(mint, tags);
  }
  // Remember misses as empty so we do not re-query within the TTL.
  for (const mint of pending) {
    if (!nextMap.has(mint)) {
      nextMap.set(mint, []);
      result.set(mint, []);
    }
  }
  cache = { expiresAt: now + CACHE_TTL_MS, tagsByMint: nextMap };
  return result;
}

/** Test helper to clear the module cache. */
export function clearJupiterTagsCache() {
  cache = null;
}
