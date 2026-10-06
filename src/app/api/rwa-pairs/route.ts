import { apiError } from "@/lib/api-response";
import { discoverRwaPairs, type RwaPairSortBy } from "@/lib/rwa-pairs";

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
    const result = await discoverRwaPairs({
      minTvl,
      maxPages,
      sortBy: sortRaw as RwaPairSortBy,
    });
    return Response.json(result, {
      headers: { "Cache-Control": "public, max-age=30, stale-while-revalidate=60" },
    });
  } catch (error) {
    return apiError(error, "RWA pair discovery failed", 503);
  }
}
