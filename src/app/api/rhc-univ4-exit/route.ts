import { json, readJson, gated } from "@/lib/api/route";
import { apiError } from "@/lib/api-response";
import { isRhcUniv4TxBuildEnabled } from "@/lib/protocol-flags";
import { evmLiquiditySchemasFor, runEvmExit } from "@/lib/dex";

/**
 * POST /api/rhc-univ4-exit — Robinhood Chain Uniswap v4 close-position (PR7).
 * `{ action: "positions", user, tokenIds }` → owner / pool / liquidity per NFT id.
 * `{ action: "prepare", user, tokenId }` → owner + allowlist checks, eth_simulateV1 from the owner, unsigned
 * `PositionManager.modifyLiquidities` (DECREASE_LIQUIDITY → BURN_POSITION → TAKE_PAIR to the owner, value 0) + gas.
 * Behind `RHC_UNIV4_TX_BUILD_ENABLED` (disabled targets → 404). Never signs or broadcasts. No fee on exit.
 */
export const POST = gated(isRhcUniv4TxBuildEnabled, async (request) => {
  const parsed = await readJson(request, evmLiquiditySchemasFor("uniswap-v4-rhc").exit);
  if (parsed instanceof Response) return parsed;
  try {
    const result = await runEvmExit("uniswap-v4-rhc", parsed);
    return json(result, result.state === "failed" ? 422 : 200);
  } catch (error) {
    return apiError(error, "Robinhood Chain close build failed", 503);
  }
});

export function GET() {
  return json({ error: "Not found" }, 404);
}
