import { rpcConnection } from "@/lib/rpc";
import { withSelectedDeadline } from "@/lib/selected-deadline";
import { parseSelectedQuoteRequest } from "@/lib/api-input";
import { apiError } from "@/lib/api-response";
import { getSelectedQuoteBundle } from "@/lib/selected-quote";

export async function POST(request: Request) {
  return withSelectedDeadline(request, async (signal) => {
  try {
    const { wallet, selection, amount, floorBps, toleranceBps } = await parseSelectedQuoteRequest(request);
    const { quote } = await getSelectedQuoteBundle(wallet, selection, amount, floorBps, toleranceBps, { maxAccounts: 24 },
      { buildTransactions: false, includeResale: false, signal, connection: rpcConnection(undefined, { signal }) });
    signal.throwIfAborted();
    return Response.json(quote, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiError(error, "Quote failed");
  }
  });
}
