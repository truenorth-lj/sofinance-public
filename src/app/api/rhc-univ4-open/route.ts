import { json, readJson, gated } from "@/lib/api/route";
import { apiError } from "@/lib/api-response";
import { isRhcUniv4TxBuildEnabled } from "@/lib/protocol-flags";
import { EvmLiquidityInputError, evmLiquiditySchemasFor, runEvmOpen } from "@/lib/dex";

/**
 * POST /api/rhc-univ4-open — build + simulate a Uniswap v4 (Robinhood Chain) open-position transaction.
 * `{ action: "prepare" }` → Permit2 typed data + pre-sign simulation; `{ action: "finalize" }` with the signature →
 * unsigned `execute` + gas. Behind `RHC_UNIV4_TX_BUILD_ENABLED` (disabled targets → 404). Never signs or broadcasts.
 */
export const POST = gated(isRhcUniv4TxBuildEnabled, async (request) => {
  const parsed = await readJson(request, evmLiquiditySchemasFor("uniswap-v4-rhc").open);
  if (parsed instanceof Response) return parsed;
  try {
    const result = await runEvmOpen("uniswap-v4-rhc", parsed);
    return json(result, result.state === "failed" ? 422 : 200);
  } catch (error) {
    if (error instanceof EvmLiquidityInputError) return json({ error: error.message }, 400);
    return apiError(error, "Robinhood Chain open build failed", 503);
  }
});

export function GET() {
  return json({ error: "Not found" }, 404);
}
