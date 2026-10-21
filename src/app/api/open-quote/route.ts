import "@/lib/engine-host";
import { withJupiterRelay } from "@/lib/jupiter-relay-route";
import { parseOpenQuoteRequest } from "@/lib/open-api";
import { apiError } from "@/lib/api-response";
import { getOpenPositionQuoteBundle } from "@sofinance/engine/open-quote";

export async function POST(request: Request) {
  return withJupiterRelay(request, async () => {
  try {
    const { wallet, selection, amount, range, floorBps, toleranceBps } = await parseOpenQuoteRequest(request);
    // Preview: quote-only (no swap-instructions); prepare builds from fresh quotes.
    const { quote } = await getOpenPositionQuoteBundle(wallet, selection, amount, range, floorBps, toleranceBps,
      undefined, undefined, "parallel", { build: false });
    return Response.json(quote, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiError(error, "Open-position quote failed");
  }
  });
}
