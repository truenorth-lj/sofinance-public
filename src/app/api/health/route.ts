import { NO_STORE_HEADERS } from "@/lib/http/no-store";

/**
 * Liveness probe for container hosts (Railway's deploy healthcheck; see docs/deploy/railway.md).
 *
 * It only proves the Next.js server is up and routing. It deliberately touches no database, RPC or third-party
 * API: a dependency outage must not fail a deploy or block a rollback, and the probe must stay free to call.
 * Data health is already visible on the real endpoints (/api/rwa-pairs) and in Sentry.
 */
export const dynamic = "force-dynamic";

export function GET() {
  return Response.json({ status: "ok" }, { status: 200, headers: NO_STORE_HEADERS });
}
