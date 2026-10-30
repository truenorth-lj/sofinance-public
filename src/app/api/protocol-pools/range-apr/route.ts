import { apiError } from "@/lib/api-response";
import { fetchMeteoraRangeApr, isAllowlistedMeteoraPool } from "@/lib/meteora-range-apr";
import { fetchOrcaRangeApr, isAllowlistedOrcaPool } from "@/lib/orca-range-apr";
import { isMeteoraDlmmDiscoveryEnabled, isOrcaDiscoveryEnabled, isRhcApr7dEnabled } from "@/lib/protocol-flags";
import { isAllowlistedRhcPool } from "@/lib/rhc-range-apr";
import { getRhcAprSnapshot } from "@/lib/rhc-snapshot";
import { snapshotError } from "@/lib/rwa-store";
import { getRwaConfig } from "@/lib/config/rwa-env";

/**
 * Read-only Orca Whirlpool pool state, range APR presets and liquidity distribution
 * (`?protocol=orca-whirlpool&poolId=…`, same payload shape as `/api/pool-range-apr` plus `state`).
 * Behind `ORCA_DISCOVERY_ENABLED` (off in production → 404); allowlisted pools only.
 * `?protocol=meteora-dlmm&poolId=…` serves Meteora; `?protocol=uniswap-v4-rhc&poolId=…` serves Robinhood Chain
 * Uniswap v4 (behind `RHC_APR7D_ENABLED`).
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
  if (protocol === "uniswap-v4-rhc") {
    if (!isRhcApr7dEnabled() || !isAllowlistedRhcPool(poolId)) return NOT_FOUND();
    try {
      // Same saved snapshot as `/api/pool-range-apr?poolId=0x…` (live only without a store, i.e. local dev).
      const payload = await getRhcAprSnapshot(poolId);
      return Response.json(payload, { headers: payload.sample.degraded ? DEGRADED_CDN_HEADERS : CDN_HEADERS });
    } catch (error) {
      if (getRwaConfig().enabled) return snapshotError(error);
      return apiError(error, "RHC range APR unavailable", 503);
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
