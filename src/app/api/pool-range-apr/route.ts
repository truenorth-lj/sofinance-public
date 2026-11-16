import { apiError } from "@/lib/api-response";
import { getPoolAprSnapshot, snapshotError } from "@/lib/rwa-store";
import { getRwaConfig } from "@/lib/config/rwa-env";
import { NotRaydiumClmmPoolError } from "@/lib/range-apr/not-clmm-pool";
import { RwaStoreError } from "@/lib/rwa-store-types";
import { rangeAprCdnHeaders } from "@/lib/range-apr/http-cache";

/**
 * One request per pool returns everything needed to price any range: the per-bin liquidity/volume model, the
 * four presets already priced, and the sample description. Upstream calls are cached per instance with
 * in-flight de-duplication (see `pool-range-apr.ts`); the CDN header keeps repeat browsers off the server.
 */
export const revalidate = 30;

const POOL_ID = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export async function GET(request: Request) {
  const poolId = new URL(request.url).searchParams.get("poolId");
  if (!poolId || !POOL_ID.test(poolId)) {
    return apiError(new Error("A valid poolId is required"), "Invalid pool id", 400);
  }
  try {
    const payload = await getPoolAprSnapshot(poolId);
    const headers = rangeAprCdnHeaders(payload.sample.degraded);
    return Response.json(payload, { headers: { ...headers, "Vercel-CDN-Cache-Control": headers["CDN-Cache-Control"] } });
  } catch (error) {
    if (getRwaConfig().enabled) return snapshotError(error);
    if (error instanceof NotRaydiumClmmPoolError) return snapshotError(new RwaStoreError("POOL_NOT_TRACKED"));
    return apiError(error, "Range APR estimate unavailable", 503);
  }
}
