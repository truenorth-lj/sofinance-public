import { parseOpenQuoteRequest } from "@/lib/open-api";
import { apiError } from "@/lib/api-response";
import { getOpenPositionQuoteBundle } from "@/lib/open-quote";

export async function POST(request: Request) {
  try {
    const { wallet, selection, amount, range, floorBps, toleranceBps } = await parseOpenQuoteRequest(request);
    const { quote } = await getOpenPositionQuoteBundle(wallet, selection, amount, range, floorBps, toleranceBps);
    return Response.json(quote, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiError(error, "Open-position quote failed");
  }
}
