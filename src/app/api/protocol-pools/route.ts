import { protocolPoolReadPolicyFor, readProtocolPools } from "@/lib/dex";
import { apiError } from "@/lib/api-response";
import { snapshotError } from "@/lib/rwa-store";
import { getRwaConfig } from "@/lib/config/rwa-env";
import { NO_STORE_HEADERS } from "@/lib/http/no-store";

/**
 * Read-only pool discovery for protocols that are not yet in `/api/rwa-pairs`.
 * - `?protocol=orca-whirlpool` (default), behind `ORCA_DISCOVERY_ENABLED`;
 * - `?protocol=uniswap-v4-rhc` (Uniswap v4 on Robinhood Chain), behind `RHC_UNIV4_DISCOVERY_ENABLED`; served from
 *   the cron's saved pool summaries (`rwa_pool_latest`, feed `uniswap-v4-rhc-v1`) when the RWA store is on;
 * - `?protocol=meteora-dlmm` (Meteora DLMM), behind `METEORA_DLMM_DISCOVERY_ENABLED`.
 * Each module retains its existing discovery flag. Disabled or unknown protocols return 404.
 */
export async function GET(request: Request) {
  const protocol = new URL(request.url).searchParams.get("protocol") ?? "orca-whirlpool";
  try {
    const payload = await readProtocolPools(protocol);
    if (payload === null) return Response.json({ error: "Not found" }, { status: 404, headers: NO_STORE_HEADERS });
    return Response.json(payload, { headers: {
      "Cache-Control": "public, max-age=0, must-revalidate",
      "CDN-Cache-Control": "public, s-maxage=60, stale-while-revalidate=300",
    } });
  } catch (error) {
    // RHC is served from the cron snapshot when the store is on; its errors carry the store's code.
    if (protocolPoolReadPolicyFor(protocol)?.snapshotBacked && getRwaConfig().enabled) return snapshotError(error);
    return apiError(error, "Protocol pool discovery failed");
  }
}
