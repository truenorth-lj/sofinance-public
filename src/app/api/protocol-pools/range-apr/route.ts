import { protocolPoolReadPolicyFor, readProtocolRangeApr } from "@/lib/dex";
import { apiError } from "@/lib/api-response";
import { snapshotError } from "@/lib/rwa-store";
import { getRwaConfig } from "@/lib/config/rwa-env";
import { NO_STORE_HEADERS } from "@/lib/http/no-store";
import { rangeAprCdnHeaders } from "@/lib/range-apr/http-cache";

/**
 * Read-only Orca Whirlpool pool state, range APR presets and liquidity distribution
 * (`?protocol=orca-whirlpool&poolId=…`, same payload shape as `/api/pool-range-apr` plus `state`).
 * Behind `ORCA_DISCOVERY_ENABLED` (off in production → 404); allowlisted pools only.
 * `?protocol=meteora-dlmm&poolId=…` serves Meteora; `?protocol=uniswap-v4-rhc&poolId=…` serves Robinhood Chain
 * Uniswap v4 (behind `RHC_APR7D_ENABLED`).
 */
const NOT_FOUND = () => Response.json({ error: "Not found" }, { status: 404, headers: NO_STORE_HEADERS });

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const protocol = params.get("protocol") ?? "orca-whirlpool";
  const poolId = params.get("poolId") ?? "";
  try {
    const payload = await readProtocolRangeApr(protocol, poolId);
    if (payload === null) return NOT_FOUND();
    return Response.json(payload, { headers: rangeAprCdnHeaders(payload.sample.degraded) });
  } catch (error) {
    const policy = protocolPoolReadPolicyFor(protocol);
    if (policy?.snapshotBacked && getRwaConfig().enabled) return snapshotError(error);
    return apiError(error, policy?.rangeAprUnavailableMessage ?? "Protocol range APR unavailable", 503);
  }
}
