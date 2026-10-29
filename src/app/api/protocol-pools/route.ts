import { apiError } from "@/lib/api-response";
import { discoverOrcaPairs } from "@/lib/orca-pairs";
import { isOrcaDiscoveryEnabled } from "@/lib/protocol-flags";

/**
 * Read-only pool discovery for protocols that are not yet in `/api/rwa-pairs`.
 * Currently only `?protocol=orca-whirlpool`, behind `ORCA_DISCOVERY_ENABLED`
 * (off in production → 404). Rows cannot be opened yet.
 */
export async function GET(request: Request) {
  const protocol = new URL(request.url).searchParams.get("protocol") ?? "orca-whirlpool";
  if (protocol !== "orca-whirlpool" || !isOrcaDiscoveryEnabled())
    return Response.json({ error: "Not found" }, { status: 404, headers: { "Cache-Control": "no-store" } });
  try {
    return Response.json(await discoverOrcaPairs(), { headers: {
      "Cache-Control": "public, max-age=0, must-revalidate",
      "CDN-Cache-Control": "public, s-maxage=60, stale-while-revalidate=300",
    } });
  } catch (error) {
    return apiError(error, "Protocol pool discovery failed");
  }
}
