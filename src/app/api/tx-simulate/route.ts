import "@/lib/engine-host";
import { apiError } from "@/lib/api-response";
import { parsePermittedTx } from "@/lib/tx-simulate/permitted-input.server";
import { simulateBeforeWallet } from "@/lib/tx-simulate/simulate.server";
import { clientIp, txSimulateCheckRateLimited, txSimulateRateLimited } from "@/lib/tx-send/rate-limit";

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * Read-only pre-wallet check (tx pipeline preflight): simulates a transaction this app prepared (the prepare-issued
 * check permit covers these bytes and its `lastValidBlockHeight`) on public RPC, and answers in plain words. Once
 * that height has passed it answers "expired" without simulating. Rate limited per IP, per permit and per wallet.
 * It never sends or signs anything.
 */
export async function POST(request: Request) {
  if (txSimulateRateLimited(clientIp(request))) return tooMany();
  let input: ReturnType<typeof parsePermittedTx>;
  try {
    input = parsePermittedTx(await request.json() as Record<string, unknown> | null);
  } catch (error) {
    return apiError(error, "Transaction simulation failed", 400);
  }
  if (txSimulateCheckRateLimited(input.landedPermit, input.wallet)) return tooMany();
  return Response.json(await simulateBeforeWallet(input.transaction, { lastValidBlockHeight: input.lastValidBlockHeight }), { headers: NO_STORE });
}

function tooMany() {
  return Response.json({ ok: null, unavailable: true }, { status: 429, headers: { ...NO_STORE, "Retry-After": "10" } });
}
