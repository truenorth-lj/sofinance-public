import "@/lib/engine-host";
import { getSigningSecret } from "@sofinance/engine/config/server-env";
import { withJupiterRelay } from "@/lib/jupiter-relay-route";
import { withSelectedDeadline } from "@/lib/selected-deadline";
import { parseSelectedQuoteRequest } from "@sofinance/engine/api-input";
import { selectedApiError } from "@/lib/api-response";
import { prepareAdd, APP_ADD_PREPARE } from "@/lib/dex";

export async function POST(request: Request) {
  return withJupiterRelay(request, () => withSelectedDeadline(request, async (signal, budget) => {
  try {
    const { wallet, selection, amount, floorBps, toleranceBps } = await parseSelectedQuoteRequest(request);
    const { summary, permit, unsignedTransaction, sendPermit, landedPermit } = await prepareAdd(
      "raydium-clmm", { wallet, selection, amount, floorBps, toleranceBps }, getSigningSecret, APP_ADD_PREPARE, { signal, budget },
    );
    return Response.json({ ...summary, permit, unsignedTransaction, sendPermit, landedPermit }, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return selectedApiError(error, "Transaction preparation failed");
  }
  }));
}
