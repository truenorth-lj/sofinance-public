import { after } from "next/server";
import { unstable_cache } from "next/cache";
import { apiError } from "@/lib/api-response";
import { dexRegistry, DexError } from "@/lib/dex";
import { fetchPoolDailyApr, getCachedPoolDailyApr, NotRaydiumPoolError } from "@/lib/pool-daily-apr";

export const revalidate = 3600;

const CDN_HEADERS = {
  "Cache-Control": "public, max-age=0, must-revalidate",
  "CDN-Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400",
  "Vercel-CDN-Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400",
};
/** A degraded answer (`degraded` set): one minute at the CDN, never in `unstable_cache`. */
const DEGRADED_HEADERS = {
  "Cache-Control": "public, max-age=0, must-revalidate",
  "CDN-Cache-Control": "public, s-maxage=60",
  "Vercel-CDN-Cache-Control": "public, s-maxage=60",
};
const headersFor = (result: { degraded?: string }) => (result.degraded ? DEGRADED_HEADERS : CDN_HEADERS);

/** Carries a degraded answer out of `unstable_cache`, which keeps only values its function returns. */
class DegradedAnswer extends Error {
  constructor(readonly result: Awaited<ReturnType<typeof loadPoolDailyApr>>) {
    super("degraded pool daily APR answer");
  }
}

function parsePoolId(raw: string | null) {
  if (!raw) throw new Error("poolId is required");
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(raw)) throw new Error("Invalid poolId");
  return raw;
}

/**
 * The series comes from the registered DEX that lists the pool (DEX registry, e.g. Meteora DLMM); pools no registered
 * DEX lists keep the existing Raydium path unchanged (pinned by route.test.ts).
 *
 * When a DEX could not tell whether it lists the pool (its pool list is down), Raydium is still asked: a Raydium pool is
 * served as before; otherwise (Raydium has no such pool, or is down too) that DEX's error is rethrown (5xx, uncached)
 * instead of a Raydium-shaped series of nulls. Nothing is cached on any error path.
 */
async function loadPoolDailyApr(poolId: string) {
  let registryFailure: { error: unknown } | null = null;
  try {
    const listed = await dexRegistry.poolDailyApr(poolId);
    if (listed) return listed;
  } catch (error) {
    registryFailure = { error };
  }
  try {
    return await fetchPoolDailyApr(poolId);
  } catch (error) {
    throw registryFailure ? registryFailure.error : error;
  }
}

const DEX_ERROR_STATUS: Partial<Record<DexError["code"], number>> = { UPSTREAM: 502, MISCONFIGURED: 503 };

function errorStatus(error: unknown) {
  if (error instanceof NotRaydiumPoolError) return 404;
  if (error instanceof DexError) return DEX_ERROR_STATUS[error.code] ?? 400;
  return 400;
}

async function getCachedDiscovery(poolId: string) {
  try {
    return await cachedDiscovery(poolId);
  } catch (error) {
    if (error instanceof DegradedAnswer) return error.result;
    throw error;
  }
}

function cachedDiscovery(poolId: string) {
  return unstable_cache(
    async () => {
      const result = await loadPoolDailyApr(poolId);
      if (result.degraded) throw new DegradedAnswer(result);
      return result;
    },
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
            await loadPoolDailyApr(poolId);
          } catch {
            /* stale payload already returned */
          }
        });
      }
      return Response.json(inMemory, { headers: headersFor(inMemory) });
    }

    const result = withAge(await getCachedDiscovery(poolId));
    if (result.stale) {
      after(async () => {
        try {
          await loadPoolDailyApr(poolId);
        } catch {
          /* stale payload already returned */
        }
      });
    }
    return Response.json(result, { headers: headersFor(result) });
  } catch (error) {
    // apiError answers `Cache-Control: no-store`; the CDN headers are only ever set on a 200.
    return apiError(error, "Pool daily APR lookup failed", errorStatus(error));
  }
}
