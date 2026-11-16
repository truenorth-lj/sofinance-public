import "@/lib/engine-host";
import { withJupiterRelay } from "@/lib/jupiter-relay-route";
import { parseOpenQuoteRequest } from "@/lib/open-api";
import { apiError } from "@/lib/api-response";
import { quoteOpen, APP_OPEN_QUOTE } from "@/lib/dex";
// Sizing stays on the engine loop (`OPEN_POSITION_ALLOCATE_MODE`). Single-shot
// is prototyped in `src/lib/open-allocate.ts`; switching needs an engine flag.

export async function POST(request: Request) {
  return withJupiterRelay(request, async () => {
  try {
    const { wallet, selection, amount, range, floorBps, toleranceBps } = await parseOpenQuoteRequest(request);
    const quote = await quoteOpen("raydium-clmm", { wallet, selection, amount, range, floorBps, toleranceBps }, APP_OPEN_QUOTE);
    return Response.json(quote, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiError(error, "Open-position quote failed");
  }
  });
}
