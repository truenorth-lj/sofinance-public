import { apiError } from "@/lib/api-response";
import { isPoolActivityEnabled } from "@/lib/protocol-flags";
import { getPoolActivitySnapshot, unavailablePoolActivitySnapshot } from "@/lib/solami-blur";

export const dynamic = "force-dynamic";

function parsePoolId(raw: string | null) {
  if (!raw) throw new Error("poolId is required");
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(raw)) throw new Error("Invalid poolId");
  return raw;
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const poolId = parsePoolId(url.searchParams.get("poolId"));
    const limitRaw = url.searchParams.get("limit");
    const limit = limitRaw === null || limitRaw === "" ? 20 : Number(limitRaw);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      throw new Error("limit must be an integer 1–200");
    }
    // Flag off: answer locally, never contact Solami.
    const snapshot = isPoolActivityEnabled()
      ? await getPoolActivitySnapshot(poolId, { limit })
      : unavailablePoolActivitySnapshot(poolId, "disabled");
    return Response.json(snapshot, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return apiError(error, "Pool activity lookup failed", 400);
  }
}
