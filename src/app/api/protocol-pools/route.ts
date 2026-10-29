import { apiError } from "@/lib/api-response";
import { discoverMeteoraPairs } from "@/lib/meteora-pairs";
import { discoverOrcaPairs } from "@/lib/orca-pairs";
import { isMeteoraDlmmDiscoveryEnabled, isOrcaDiscoveryEnabled, isRhcUniv4DiscoveryEnabled } from "@/lib/protocol-flags";
import { discoverRhcUniv4Pools } from "@/lib/rhc-univ4-pools";

/**
 * Read-only pool discovery for protocols that are not yet in `/api/rwa-pairs`.
 * - `?protocol=orca-whirlpool` (default), behind `ORCA_DISCOVERY_ENABLED`;
 * - `?protocol=uniswap-v4-rhc` (Uniswap v4 on Robinhood Chain), behind `RHC_UNIV4_DISCOVERY_ENABLED`;
 * - `?protocol=meteora-dlmm` (Meteora DLMM), behind `METEORA_DLMM_DISCOVERY_ENABLED`.
 * All flags are off in production → 404. Rows cannot be opened yet.
 */
const DISCOVERY = {
  "orca-whirlpool": { enabled: isOrcaDiscoveryEnabled, load: () => discoverOrcaPairs() },
  "uniswap-v4-rhc": { enabled: isRhcUniv4DiscoveryEnabled, load: () => discoverRhcUniv4Pools() },
  "meteora-dlmm": { enabled: isMeteoraDlmmDiscoveryEnabled, load: () => discoverMeteoraPairs() },
} as const;

export async function GET(request: Request) {
  const protocol = new URL(request.url).searchParams.get("protocol") ?? "orca-whirlpool";
  const entry = Object.hasOwn(DISCOVERY, protocol) ? DISCOVERY[protocol as keyof typeof DISCOVERY] : null;
  if (!entry || !entry.enabled())
    return Response.json({ error: "Not found" }, { status: 404, headers: { "Cache-Control": "no-store" } });
  try {
    return Response.json(await entry.load(), { headers: {
      "Cache-Control": "public, max-age=0, must-revalidate",
      "CDN-Cache-Control": "public, s-maxage=60, stale-while-revalidate=300",
    } });
  } catch (error) {
    return apiError(error, "Protocol pool discovery failed");
  }
}
