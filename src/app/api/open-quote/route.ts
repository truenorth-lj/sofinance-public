import "@/lib/engine-host";
import { withJupiterRelay } from "@/lib/jupiter-relay-route";
import { parseOpenQuoteRequest } from "@/lib/open-api";
import { cachedOpenPoolState } from "@/lib/open-pool-snapshot";
import { apiError } from "@/lib/api-response";
import { JUPITER_MAX_ACCOUNTS } from "@sofinance/engine/jupiter-route-retry";
import { getOpenPositionQuoteBundle } from "@sofinance/engine/open-quote";
import { runWithOpenDiag } from "@sofinance/engine/diag-store";
// Sizing stays on the engine loop (`OPEN_POSITION_ALLOCATE_MODE`). Single-shot
// is prototyped in `src/lib/open-allocate.ts`; switching needs an engine flag.

export async function POST(request: Request) {
  return withJupiterRelay(request, async () => {
  try {
    const { wallet, selection, amount, range, floorBps, toleranceBps, diag } = await parseOpenQuoteRequest(request);
    // Preview: quote-only (no swap-instructions); prepare builds from fresh quotes.
    // `{ maxAccounts: 48 }` matches prepare's first (relay) attempt so the sizing
    // hint key and Jupiter quote URLs are identical and prepare reuses this preview.
    const { quote } = await runWithOpenDiag(diag, async () => getOpenPositionQuoteBundle(wallet, selection, amount, range, floorBps, toleranceBps,
      { maxAccounts: JUPITER_MAX_ACCOUNTS.wide }, await cachedOpenPoolState(wallet, selection),
      "parallel", { build: false }));
    return Response.json(quote, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiError(error, "Open-position quote failed");
  }
  });
}
