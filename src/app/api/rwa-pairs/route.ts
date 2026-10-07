import { after } from "next/server";
import { apiError } from "@/lib/api-response";
import { discoverRwaPairs, getCachedRwaPairs, type RwaPairSortBy } from "@/lib/rwa-pairs";

export const dynamic = "force-dynamic";

function parseNumber(raw: string | null, fallback: number, min: number, max: number) {
  if (raw === null || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`Invalid numeric query parameter (expected ${min}–${max})`);
  }
  return value;
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

    // Check cache first - always return cached data immediately if available
    const cached = getCachedRwaPairs(minTvl, maxPages, sortBy);
    
    if (cached) {
      // We have cached data - return it immediately
      const result = cached;
      
      // If stale (> 1 hour), schedule a background refresh
      if (cached.stale) {
        after(async () => {
          try {
            // Refresh in background - don't await, don't block response
            await discoverRwaPairs({ minTvl, maxPages, sortBy });
          } catch {
            // Silently fail - stale data already returned to user
          }
        });
      }
      
      // Return cached data with longer CDN cache and SWR
      return Response.json(result, {
        headers: {
          "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400",
        },
      });
    }

    // No cache - this is a cold start, must block on fresh discovery
    const result = await discoverRwaPairs({ minTvl, maxPages, sortBy });
    
    return Response.json(result, {
      headers: {
        "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400",
      },
    });
  } catch (error) {
    return apiError(error, "RWA pair discovery failed", 503);
  }
}
