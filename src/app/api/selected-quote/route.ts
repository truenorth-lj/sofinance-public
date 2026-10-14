import { rpcConnection } from "@/lib/rpc";
import { withSelectedDeadline } from "@/lib/selected-deadline";
import { parseSelectedQuoteRequest } from "@/lib/api-input";
import { selectedApiError } from "@/lib/api-response";
import { getSelectedQuoteBundle } from "@/lib/selected-quote";
import { JUPITER_MAX_ACCOUNTS } from "@/lib/jupiter-route-retry";

export async function POST(request: Request) {
  return withSelectedDeadline(request, async (signal, budget) => {
  try {
    const { wallet, selection, amount, floorBps, toleranceBps } = await parseSelectedQuoteRequest(request);
    const { quote } = await getSelectedQuoteBundle(wallet, selection, amount, floorBps, toleranceBps, { maxAccounts: JUPITER_MAX_ACCOUNTS.compact },
      { buildTransactions: false, includeResale: false, signal, budget, connection: rpcConnection(undefined, { signal }) });
    signal.throwIfAborted();
    return Response.json(quote, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return selectedApiError(error, "Quote failed");
  }
  });
}
