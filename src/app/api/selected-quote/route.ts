import { parseSelectedQuoteRequest } from "@/lib/api-input";
import { apiError } from "@/lib/api-response";
import { getSelectedQuoteBundle } from "@/lib/selected-quote";

export async function POST(request: Request) {
  try {
    const { wallet, selection, amount, floorBps } = await parseSelectedQuoteRequest(request);
    const { quote } = await getSelectedQuoteBundle(wallet, selection, amount, floorBps);
    return Response.json(quote, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiError(error, "Quote failed");
  }
}
