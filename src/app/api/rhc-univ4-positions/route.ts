import { getAddress, isAddress } from "viem";
import { isRhcUniv4TradingEnabled } from "@/lib/protocol-flags";
import { RHC_SCAN_FAILED_MESSAGE, rhcScanRateLimited, RhcScanBusyError, scanRhcPositions } from "@/lib/rhc-position-scan";
import { logSafeError } from "@/lib/safe-error-log";

/**
 * GET /api/rhc-univ4-positions?wallet=0x…[&fresh=1] — the Robinhood Chain Uniswap v4 position NFTs the wallet holds
 * now (PositionManager Transfer logs to/from the wallet on the official public RPC, confirmed with ownerOf), with
 * owner / pool / ticks / liquidity per NFT. Read-only and public data; served from a per-wallet server cache.
 * Per-IP limit on this instance; a failed scan answers 503 with a plain message (the page still shows its local
 * records and the manual NFT entry).
 */
const NO_STORE = { "Cache-Control": "no-store" } as const;
const clientIp = (request: Request) => request.headers.get("x-real-ip")?.trim()
  || request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";

export async function GET(request: Request) {
  if (!isRhcUniv4TradingEnabled()) return Response.json({ error: "Not found" }, { status: 404, headers: NO_STORE });
  const url = new URL(request.url);
  const raw = url.searchParams.get("wallet") ?? "";
  if (raw.length !== 42 || !isAddress(raw, { strict: false })) {
    return Response.json({ error: "Invalid wallet address" }, { status: 400, headers: NO_STORE });
  }
  if (rhcScanRateLimited(clientIp(request))) {
    return Response.json({ error: "Too many requests. Please wait a minute." }, { status: 429, headers: { ...NO_STORE, "Retry-After": "60" } });
  }
  const fresh = url.searchParams.get("fresh") === "1";
  try {
    const result = await scanRhcPositions(getAddress(raw), { fresh });
    return Response.json(result, { status: 200, headers: NO_STORE });
  } catch (error) {
    const busy = error instanceof RhcScanBusyError;
    if (!busy) logSafeError("Robinhood Chain position scan failed", error);
    return Response.json({ error: RHC_SCAN_FAILED_MESSAGE, code: busy ? "rpc_busy" : "rpc_unavailable" }, {
      status: 503, headers: { ...NO_STORE, ...(busy ? { "Retry-After": String(Math.max(1, Math.ceil(error.retryAfterMs / 1000))) } : {}) },
    });
  }
}
