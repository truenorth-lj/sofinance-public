import { after } from "next/server";
import { unstable_cache } from "next/cache";
import { apiError } from "@/lib/api-response";
import { fetchPoolDailyApr, getCachedPoolDailyApr } from "@/lib/pool-daily-apr";

export const revalidate = 3600;

const CDN_HEADERS = {
  "Cache-Control": "public, max-age=0, must-revalidate",
  "CDN-Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400",
  "Vercel-CDN-Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400",
};

function parsePoolId(raw: string | null) {
  if (!raw) throw new Error("poolId is required");
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(raw)) throw new Error("Invalid poolId");
  return raw;
}

function getCachedDiscovery(poolId: string) {
  return unstable_cache(
    async () => fetchPoolDailyApr(poolId),
    [`pool-daily-apr-${poolId}`],
    {
      revalidate: 3600,
      tags: ["pool-daily-apr"],
    },
  )();
}

function withAge(result: Awaited<ReturnType<typeof fetchPoolDailyApr>>) {
  const now = Date.now();
  const fetchedAt = new Date(result.fetchedAt).getTime();
  const ageMs = now - fetchedAt;
  return {
    ...result,
    cachedAt: result.fetchedAt,
    stale: ageMs > 3_600_000,
    ageSeconds: Math.round(ageMs / 1000),
  };
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const poolId = parsePoolId(url.searchParams.get("poolId"));

    const inMemory = getCachedPoolDailyApr(poolId);
    if (inMemory) {
      if (inMemory.stale) {
        after(async () => {
          try {
            await fetchPoolDailyApr(poolId);
          } catch {
            /* stale payload already returned */
          }
        });
      }
      return Response.json(inMemory, { headers: CDN_HEADERS });
    }

    const result = withAge(await getCachedDiscovery(poolId));
    if (result.stale) {
      after(async () => {
        try {
          await fetchPoolDailyApr(poolId);
        } catch {
          /* stale payload already returned */
        }
      });
    }
    return Response.json(result, { headers: CDN_HEADERS });
  } catch (error) {
    return apiError(error, "Pool daily APR lookup failed", 400);
  }
}
