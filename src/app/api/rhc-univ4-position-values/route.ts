import { isRhcUniv4TradingEnabled } from "@/lib/protocol-flags";
import { dexRegistry, evmPositionReadPolicyFor, PositionReadBusyError, readEvmPositionValues } from "@/lib/dex";
import { logSafeError } from "@/lib/safe-error-log";
import { gated, json } from "@/lib/api/route";

/**
 * GET /api/rhc-univ4-position-values?ids=4014633,4072237 — liquidity amounts and unclaimed fees (atomic token units)
 * of Robinhood Chain Uniswap v4 position NFTs, with USD prices per token from the APR cron's saved pool data (no
 * indexer call here; older than 48h or missing: null). Public data, read on the official public RPC (two
 * multicalls), cached 30s. Shares the per-IP limit with the holdings
 * scan. A failed read answers 503; the page then shows a dash in each amount, never a zero.
 */
export const GET = gated(isRhcUniv4TradingEnabled, async (request) => {
  const ids = evmPositionReadPolicyFor("uniswap-v4-rhc").parseIds(new URL(request.url).searchParams.get("ids"));
  if (!ids) return json({ error: "Invalid position ids" }, 400);
  if (dexRegistry.isRateLimited("uniswap-v4-rhc", "positions", request)) {
    return json({ error: "Too many requests. Please wait a minute." }, 429, { "Retry-After": "60" });
  }
  try {
    return json(await readEvmPositionValues("uniswap-v4-rhc", ids), 200);
  } catch (error) {
    const busy = error instanceof PositionReadBusyError;
    if (!busy) logSafeError("Robinhood Chain position values read failed", error);
    return json({ error: "Couldn't read position amounts right now.", code: busy ? "rpc_busy" : "rpc_unavailable" }, 503);
  }
});
