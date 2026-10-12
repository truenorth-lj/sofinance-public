import { withSelectedDeadline } from "@/lib/selected-deadline";
import { parseSelectedQuoteRequest } from "@/lib/api-input";
import { selectedApiError } from "@/lib/api-response";
import { buildAndSimulateSelectedZap } from "@/lib/selected-atomic";

export async function POST(request: Request) {
  return withSelectedDeadline(request, async (signal, budget) => {
  try {
    const { wallet, selection, amount, floorBps, toleranceBps } = await parseSelectedQuoteRequest(request);
    const { summary } = await buildAndSimulateSelectedZap(wallet, selection, amount, floorBps, toleranceBps,
      { enforceResaleFloor: false, signal, budget });
    signal.throwIfAborted();
    return Response.json(summary, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return selectedApiError(error, "Complete simulation failed");
  }
  });
}
