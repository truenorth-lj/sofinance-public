import "@/lib/engine-host";
import { rpcConnection } from "@sofinance/engine/rpc";
import { withSelectedDeadline } from "@/lib/selected-deadline";
import { parseSelectedQuoteRequest } from "@sofinance/engine/api-input";
import { selectedApiError } from "@/lib/api-response";
import { searchSelectedQuoteBundle } from "@/lib/selected-quote";

export async function POST(request: Request) {
  return withSelectedDeadline(request, async (signal, budget) => {
  try {
    const { wallet, selection, amount, floorBps, toleranceBps } = await parseSelectedQuoteRequest(request);
    const { quote } = await searchSelectedQuoteBundle(wallet, selection, amount, floorBps, toleranceBps,
      { buildTransactions: false, includeResale: false, signal, budget, connection: rpcConnection(undefined, { signal }) });
    signal.throwIfAborted();
    return Response.json(quote, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return selectedApiError(error, "Quote failed");
  }
  });
}
