import { apiError } from "@/lib/api-response";
import { fetchMeteoraRangeApr, isAllowlistedMeteoraPool } from "@/lib/meteora-range-apr";
import { fetchOrcaRangeApr, isAllowlistedOrcaPool } from "@/lib/orca-range-apr";
import { isMeteoraDlmmDiscoveryEnabled, isOrcaDiscoveryEnabled } from "@/lib/protocol-flags";

/**
 * Read-only Orca Whirlpool pool state, range APR presets and liquidity distribution
 * (`?protocol=orca-whirlpool&poolId=…`, same payload shape as `/api/pool-range-apr` plus `state`).
 * Behind `ORCA_DISCOVERY_ENABLED` (off in production → 404); allowlisted pools only.
 * `?protocol=meteora-dlmm&poolId=…` serves the Meteora DLMM equivalent (bin arrays, estimated APR) behind
 * `METEORA_DLMM_DISCOVERY_ENABLED` (off in production → 404).
 */
const NOT_FOUND = () => Response.json({ error: "Not found" }, { status: 404, headers: { "Cache-Control": "no-store" } });

const CDN_HEADERS = {
  "Cache-Control": "public, max-age=0, must-revalidate",
  "CDN-Cache-Control": "public, s-maxage=30, stale-while-revalidate=300",
};
const DEGRADED_CDN_HEADERS = { "Cache-Control": "public, max-age=0, must-revalidate", "CDN-Cache-Control": "public, s-maxage=10" };

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const protocol = params.get("protocol") ?? "orca-whirlpool";
  const poolId = params.get("poolId") ?? "";
  if (protocol === "meteora-dlmm") {
    if (!isMeteoraDlmmDiscoveryEnabled() || !isAllowlistedMeteoraPool(poolId)) return NOT_FOUND();
    try {
      const payload = await fetchMeteoraRangeApr(poolId);
      return Response.json(payload, { headers: payload.sample.degraded ? DEGRADED_CDN_HEADERS : CDN_HEADERS });
    } catch (error) {
      return apiError(error, "Meteora range APR unavailable", 503);
    }
  }
  if (!isOrcaDiscoveryEnabled()) return NOT_FOUND();
  if (protocol !== "orca-whirlpool" || !isAllowlistedOrcaPool(poolId)) return NOT_FOUND();
  try {
    const payload = await fetchOrcaRangeApr(poolId);
    return Response.json(payload, { headers: payload.sample.degraded ? DEGRADED_CDN_HEADERS : CDN_HEADERS });
  } catch (error) {
    return apiError(error, "Orca range APR unavailable", 503);
  }
}
