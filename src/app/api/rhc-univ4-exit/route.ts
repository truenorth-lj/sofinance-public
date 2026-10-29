import { apiError } from "@/lib/api-response";
import { isRhcUniv4TxBuildEnabled } from "@/lib/protocol-flags";
import { RhcExitRequestSchema, runRhcUniv4Exit } from "@/lib/rhc-univ4-exit";

/**
 * POST /api/rhc-univ4-exit — Robinhood Chain Uniswap v4 close-position (PR7).
 * `{ action: "positions", user, tokenIds }` → owner / pool / liquidity per NFT id.
 * `{ action: "prepare", user, tokenId }` → owner + allowlist checks, eth_simulateV1 from the owner, unsigned
 * `PositionManager.modifyLiquidities` (DECREASE_LIQUIDITY → BURN_POSITION → TAKE_PAIR to the owner, value 0) + gas.
 * Behind `RHC_UNIV4_TX_BUILD_ENABLED` (off in production → 404). Never signs or broadcasts. No fee on exit.
 */
const NO_STORE = { "Cache-Control": "no-store" } as const;

export async function POST(request: Request) {
  if (!isRhcUniv4TxBuildEnabled()) return Response.json({ error: "Not found" }, { status: 404, headers: NO_STORE });
  let body: unknown;
  try { body = await request.json(); } catch { return Response.json({ error: "Invalid JSON" }, { status: 400, headers: NO_STORE }); }
  const parsed = RhcExitRequestSchema.safeParse(body);
  if (!parsed.success) return Response.json({ error: "Invalid request", issues: parsed.error.issues.map(i => ({ path: i.path.join("."), message: i.message })) }, { status: 400, headers: NO_STORE });
  try {
    const result = await runRhcUniv4Exit(parsed.data);
    return Response.json(result, { status: result.state === "failed" ? 422 : 200, headers: NO_STORE });
  } catch (error) {
    return apiError(error, "Robinhood Chain close build failed", 503);
  }
}

export function GET() {
  return Response.json({ error: "Not found" }, { status: 404, headers: NO_STORE });
}
