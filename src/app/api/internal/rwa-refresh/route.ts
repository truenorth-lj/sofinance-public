import { z } from "zod";
import { getRwaConfig } from "@/lib/config/rwa-env";
import { validRwaAuthorization } from "@/lib/rwa-auth";
import { refreshRwaSnapshots } from "@/lib/rwa-refresh";

export const maxDuration = 300;
export async function POST(request: Request) {
  const config = getRwaConfig();
  if (
    !validRwaAuthorization(request.headers.get("authorization"), config.secret)
  )
    return Response.json(
      { error: "Unauthorized" },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  if (!config.refreshEnabled || config.isPreview)
    return Response.json(
      { error: "Refresh is disabled" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  const parsed = z
    .object({ force: z.boolean().optional() })
    .strict()
    .safeParse(await request.json().catch(() => null));
  if (!parsed.success)
    return Response.json({ error: "Invalid request" }, { status: 400 });
  try {
    const result = await refreshRwaSnapshots({ force: parsed.data.force });
    return Response.json(result, {
      status:
        result.discovery.status === "error" || result.apr.status === "error"
          ? 503
          : 200,
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return Response.json(
      { error: "RWA refresh temporarily unavailable" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
