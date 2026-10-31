import { z } from "zod";
import { getRwaConfig } from "@/lib/config/rwa-env";
import { validRwaAuthorization } from "@/lib/rwa-auth";
import { refreshRwaSnapshots } from "@/lib/rwa-refresh";
import { captureApiRouteError } from "@/lib/sentry/capture";

// Literal for Next's static analysis; `RWA_REFRESH_MAX_DURATION_MS` (rwa-refresh.ts) budgets the jobs to it.
export const maxDuration = 300;
export function GET(request: Request) { return handleRefresh(request, "GET"); }
export function POST(request: Request) { return handleRefresh(request, "POST"); }

async function handleRefresh(request: Request, method: "GET" | "POST") {
  const config = getRwaConfig();
  if (
    !validRwaAuthorization(request.headers.get("authorization"), config.secret)
  )
    return Response.json(
      { error: "Unauthorized" },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  if (!config.refreshEnabled || config.isPreview || (method === "GET" && !config.nativeCronEnabled))
    return Response.json(
      { error: "Refresh is disabled" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  let force: boolean | undefined = false;
  if (method === "POST") {
    const parsed = z.object({ force: z.boolean().optional() }).strict()
      .safeParse(await request.json().catch(() => null));
    if (!parsed.success)
      return Response.json({ error: "Invalid request" }, { status: 400, headers: { "Cache-Control": "no-store" } });
    force = parsed.data.force;
  }
  // GET never parses a body or query, so force cannot bypass due/lease admission.
  try {
    const result = await refreshRwaSnapshots({ force });
    return Response.json(result, {
      status:
        result.discovery.status === "error" || result.apr.status === "error"
          ? 503
          : 200,
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    // Database errors may contain credentials/receipts. Monitoring gets a fixed error only.
    captureApiRouteError(new Error("RWA refresh temporarily unavailable"), { request, route: "/api/internal/rwa-refresh", fallback: "RWA refresh temporarily unavailable", status: 503 });
    return Response.json(
      { error: "RWA refresh temporarily unavailable" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
