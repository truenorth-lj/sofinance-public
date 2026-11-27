import { revalidatePath } from "next/cache";
import { getRwaConfig } from "@/lib/config/rwa-env";
import { NO_STORE_HEADERS } from "@/lib/http/no-store";
import { ISR_WARMUP_PATHS } from "@/lib/isr-warmup";
import { isRailwayRuntime } from "@/lib/request-origin/trust";
import { validRwaAuthorization } from "@/lib/rwa-auth";

export const dynamic = "force-dynamic";

/**
 * Marks the store-backed ISR pages stale so the next request renders them from the runtime env. Called once by the
 * Railway web entry right after start (`src/lib/isr-warmup.ts`), because Railway builds have no database. Takes no
 * input: the paths are the fixed `ISR_WARMUP_PATHS`. Railway only (404 elsewhere, so Vercel is unchanged), and only
 * with the CRON_SECRET bearer.
 */
export function POST(request: Request) {
  if (!isRailwayRuntime()) return Response.json({ error: "Not found" }, { status: 404, headers: NO_STORE_HEADERS });
  if (!validRwaAuthorization(request.headers.get("authorization"), getRwaConfig().secret))
    return Response.json({ error: "Unauthorized" }, { status: 401, headers: NO_STORE_HEADERS });
  for (const path of ISR_WARMUP_PATHS) revalidatePath(path);
  return Response.json({ revalidated: ISR_WARMUP_PATHS }, { headers: NO_STORE_HEADERS });
}
