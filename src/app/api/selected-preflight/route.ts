import { parseSelectedQuoteRequest } from "@/lib/api-input";
import { apiError } from "@/lib/api-response";
import { buildAndSimulateSelectedZap } from "@/lib/selected-atomic";

export async function POST(request: Request) {
  try {
    const { wallet, selection, amount, floorBps, toleranceBps } = await parseSelectedQuoteRequest(request);
    const { summary } = await buildAndSimulateSelectedZap(wallet, selection, amount, floorBps, toleranceBps);
    return Response.json(summary, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return apiError(error, "Complete simulation failed");
  }
}
