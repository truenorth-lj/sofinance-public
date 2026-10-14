import { apiError } from "@/lib/api-response";
import { getPoolAprSnapshot, snapshotError } from "@/lib/rwa-store";
import { getRwaConfig } from "@/lib/config/rwa-env";

/**
 * One request per pool returns everything needed to price any range: the per-bin liquidity/volume model, the
 * four presets already priced, and the sample description. Upstream calls are cached per instance with
 * in-flight de-duplication (see `pool-range-apr.ts`); the CDN header keeps repeat browsers off the server.
 */
export const revalidate = 30;

const CDN_HEADERS = {
  "Cache-Control": "public, max-age=0, must-revalidate",
  "CDN-Cache-Control": "public, s-maxage=30, stale-while-revalidate=300",
  "Vercel-CDN-Cache-Control": "public, s-maxage=30, stale-while-revalidate=300",
};

/** A degraded payload (no estimates) must not be pinned at the CDN for minutes. */
const DEGRADED_CDN_HEADERS = {
  "Cache-Control": "public, max-age=0, must-revalidate",
  "CDN-Cache-Control": "public, s-maxage=10",
  "Vercel-CDN-Cache-Control": "public, s-maxage=10",
};

const POOL_ID = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export async function GET(request: Request) {
  const poolId = new URL(request.url).searchParams.get("poolId");
  if (!poolId || !POOL_ID.test(poolId)) {
    return apiError(new Error("A valid poolId is required"), "Invalid pool id", 400);
  }
  try {
    const payload = await getPoolAprSnapshot(poolId);
    return Response.json(payload, { headers: payload.sample.degraded ? DEGRADED_CDN_HEADERS : CDN_HEADERS });
  } catch (error) {
    if (getRwaConfig().enabled) return snapshotError(error);
    return apiError(error, "Range APR estimate unavailable", 503);
  }
}
