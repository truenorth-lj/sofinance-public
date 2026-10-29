import { apiError } from "@/lib/api-response";
import { isRhcUniv4TxBuildEnabled } from "@/lib/protocol-flags";
import { RhcOpenInputError, RhcOpenRequestSchema, runRhcUniv4Open } from "@/lib/rhc-univ4-open";

/**
 * POST /api/rhc-univ4-open — build + simulate a Uniswap v4 (Robinhood Chain) open-position transaction.
 * `{ action: "prepare" }` → Permit2 typed data + pre-sign simulation; `{ action: "finalize" }` with the signature →
 * unsigned `execute` + gas. Behind `RHC_UNIV4_TX_BUILD_ENABLED` (off in production → 404). Never signs or broadcasts.
 */
const NO_STORE = { "Cache-Control": "no-store" } as const;

export async function POST(request: Request) {
  if (!isRhcUniv4TxBuildEnabled()) return Response.json({ error: "Not found" }, { status: 404, headers: NO_STORE });
  let body: unknown;
  try { body = await request.json(); } catch { return Response.json({ error: "Invalid JSON" }, { status: 400, headers: NO_STORE }); }
  const parsed = RhcOpenRequestSchema.safeParse(body);
  if (!parsed.success) return Response.json({ error: "Invalid request", issues: parsed.error.issues.map(i => ({ path: i.path.join("."), message: i.message })) }, { status: 400, headers: NO_STORE });
  try {
    const result = await runRhcUniv4Open(parsed.data);
    return Response.json(result, { status: result.state === "failed" ? 422 : 200, headers: NO_STORE });
  } catch (error) {
    if (error instanceof RhcOpenInputError) return Response.json({ error: error.message }, { status: 400, headers: NO_STORE });
    return apiError(error, "Robinhood Chain open build failed", 503);
  }
}

export function GET() {
  return Response.json({ error: "Not found" }, { status: 404, headers: NO_STORE });
}
