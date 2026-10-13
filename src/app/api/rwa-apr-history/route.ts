import { getRwaStore, snapshotError } from "@/lib/rwa-store";
import { POOL_ID } from "@/lib/rwa-store-types";
import { validateHistoryRange } from "@/lib/rwa-daily";

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const poolId = params.get("poolId") ?? "",
    from = params.get("from") ?? "",
    to = params.get("to") ?? "";
  try {
    if (!POOL_ID.test(poolId)) throw new Error("Invalid poolId");
    validateHistoryRange(from, to);
  } catch {
    return Response.json(
      {
        error: "A valid poolId and date range of at most 366 days are required",
      },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }
  try {
    return Response.json(
      await getRwaStore().request({ op: "history", poolId, from, to }),
      {
        headers: {
          "Cache-Control": "public, max-age=0, must-revalidate",
          "CDN-Cache-Control":
            "public, s-maxage=60, stale-while-revalidate=300",
          "Vercel-CDN-Cache-Control":
            "public, s-maxage=60, stale-while-revalidate=300",
        },
      },
    );
  } catch (error) {
    return snapshotError(error);
  }
}
