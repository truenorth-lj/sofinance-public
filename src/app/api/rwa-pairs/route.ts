import { after } from "next/server";
import { unstable_cache } from "next/cache";
import { apiError } from "@/lib/api-response";
import { discoverRwaPairs, getCachedRwaPairs, type RwaPairSortBy } from "@/lib/rwa-pairs";

// Enable CDN caching with 1 hour revalidation
export const revalidate = 3600;

function parseNumber(raw: string | null, fallback: number, min: number, max: number) {
  if (raw === null || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`Invalid numeric query parameter (expected ${min}–${max})`);
  }
  return value;
}

/**
 * Cross-instance cached discovery using Next.js Data Cache.
 * This persists across serverless cold starts on Vercel.
 */
function getCachedDiscovery(minTvl: number, maxPages: number, sortBy: RwaPairSortBy) {
  return unstable_cache(
    async () => discoverRwaPairs({ minTvl, maxPages, sortBy }),
    [`rwa-pairs-${minTvl}-${maxPages}-${sortBy}`],
    {
      revalidate: 3600, // 1 hour
      tags: [`rwa-pairs`],
    }
  )();
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const minTvl = parseNumber(url.searchParams.get("minTvl"), 0, 0, 1e12);
    const maxPages = Math.floor(parseNumber(url.searchParams.get("maxPages"), 10, 1, 30));
    const sortRaw = url.searchParams.get("sortBy") || "estimatedFeeApr";
    const allowed: RwaPairSortBy[] = ["estimatedFeeApr", "tvl", "volume24h"];
    if (!allowed.includes(sortRaw as RwaPairSortBy)) {
      throw new Error("sortBy must be estimatedFeeApr, tvl, or volume24h");
    }
    const sortBy = sortRaw as RwaPairSortBy;

    // Check in-memory cache first (fast path for same instance)
    const inMemoryCached = getCachedRwaPairs(minTvl, maxPages, sortBy);
    
    if (inMemoryCached) {
      // We have in-memory cached data - return it immediately
      const result = inMemoryCached;
      
      // If stale (> 1 hour), schedule a background refresh
      if (inMemoryCached.stale) {
        after(async () => {
          try {
            // Refresh both in-memory and Data Cache in background
            await discoverRwaPairs({ minTvl, maxPages, sortBy });
          } catch {
            // Silently fail - stale data already returned to user
          }
        });
      }
      
      // Return cached data with CDN caching enabled
      return Response.json(result, {
        headers: {
          "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400",
        },
      });
    }

    // No in-memory cache - check Next.js Data Cache (cross-instance)
    // This will hit the Data Cache on cold starts, avoiding full discovery
    const result = await getCachedDiscovery(minTvl, maxPages, sortBy);
    
    // Add cache metadata for this response
    const now = Date.now();
    const fetchedAt = new Date(result.fetchedAt).getTime();
    const ageMs = now - fetchedAt;
    const ageSeconds = Math.round(ageMs / 1000);
    const stale = ageMs > 3_600_000;
    
    const responseWithMeta = {
      ...result,
      cachedAt: result.fetchedAt,
      stale,
      ageSeconds,
    };
    
    // Schedule background refresh if stale
    if (stale) {
      after(async () => {
        try {
          await discoverRwaPairs({ minTvl, maxPages, sortBy });
        } catch {
          // Silently fail - stale data already returned
        }
      });
    }
    
    return Response.json(responseWithMeta, {
      headers: {
        "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400",
      },
    });
  } catch (error) {
    return apiError(error, "RWA pair discovery failed", 503);
  }
}
