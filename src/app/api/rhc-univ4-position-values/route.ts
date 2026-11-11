import { isRhcUniv4TradingEnabled } from "@/lib/protocol-flags";
import { RhcScanBusyError, rhcScanRateLimited } from "@/lib/rhc-position-scan";
import { parsePositionIds, rhcPositionValues } from "@/lib/rhc-position-values";
import { logSafeError } from "@/lib/safe-error-log";
import { NO_STORE_HEADERS } from "@/lib/http/no-store";

/**
 * GET /api/rhc-univ4-position-values?ids=4014633,4072237 — liquidity amounts and unclaimed fees (atomic token units)
 * of Robinhood Chain Uniswap v4 position NFTs, with USD prices per token from the APR cron's saved pool data (no
 * indexer call here; older than 48h or missing: null). Public data, read on the official public RPC (two
 * multicalls), cached 30s. Shares the per-IP limit with the holdings
 * scan. A failed read answers 503; the page then shows a dash in each amount, never a zero.
 */
const clientIp = (request: Request) => request.headers.get("x-real-ip")?.trim()
  || request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";

export async function GET(request: Request) {
  if (!isRhcUniv4TradingEnabled()) return Response.json({ error: "Not found" }, { status: 404, headers: NO_STORE_HEADERS });
  const ids = parsePositionIds(new URL(request.url).searchParams.get("ids"));
  if (!ids) return Response.json({ error: "Invalid position ids" }, { status: 400, headers: NO_STORE_HEADERS });
  if (rhcScanRateLimited(clientIp(request))) {
    return Response.json({ error: "Too many requests. Please wait a minute." }, { status: 429, headers: { ...NO_STORE_HEADERS, "Retry-After": "60" } });
  }
  try {
    return Response.json(await rhcPositionValues(ids), { status: 200, headers: NO_STORE_HEADERS });
  } catch (error) {
    const busy = error instanceof RhcScanBusyError;
    if (!busy) logSafeError("Robinhood Chain position values read failed", error);
    return Response.json({ error: "Couldn't read position amounts right now.", code: busy ? "rpc_busy" : "rpc_unavailable" }, { status: 503, headers: NO_STORE_HEADERS });
  }
}
