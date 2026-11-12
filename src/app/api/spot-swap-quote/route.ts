import "@/lib/engine-host";
import { parseWallet } from "@sofinance/engine/api-input";
import { withJupiterRelay } from "@/lib/jupiter-relay-route";
import { loadSpotSwapStockContext } from "@/lib/stock-market/source";
import { jsonObject, parseSpotSwapAmount, parseUnderlying } from "@/lib/stock-market/public";
import { json } from "@/lib/api/route";
import { SPOT_SWAP_UNAVAILABLE_MESSAGE, spotSwapErrorResponse } from "@/lib/stock-market/spot-swap-response";
import { quoteSpotSwapForStock } from "@/server/transactions/spot-swap";

const INVALID = "Enter a USDC amount with up to 6 decimals.";

/**
 * Read-only quote for the homepage Buy modal: the engine picks the issuer for this amount, the price-impact cap and
 * the fee come from the engine, and with a wallet the SOL / USDC readiness is checked. Nothing is built or signed.
 */
export async function POST(request: Request) {
  let body: Record<string, unknown> | null;
  try { body = jsonObject(await request.clone().json()); } catch { body = null; }
  if (!body) return json({ error: INVALID }, 400);
  const underlying = parseUnderlying(body.underlying);
  const amount = parseSpotSwapAmount(body.amount);
  if (!underlying || !amount) return json({ error: INVALID }, 400);
  let wallet: string | null = null;
  if (body.wallet !== undefined && body.wallet !== null) {
    try { wallet = parseWallet(body.wallet); } catch { return json({ error: "Wallet address is not valid." }, 400); }
  }
  // Outside the relay: a cache miss here calls Jupiter search, which the browser relay does not carry.
  let context;
  try { context = await loadSpotSwapStockContext(underlying); } catch (error) { return spotSwapErrorResponse(error, "Quote failed. Please try again.", "/api/spot-swap-quote"); }
  if (!context) return json({ error: SPOT_SWAP_UNAVAILABLE_MESSAGE, code: "spot_swap_unavailable" }, 404);
  return withJupiterRelay(request, async () => {
    try {
      return json(await quoteSpotSwapForStock(context, amount, wallet));
    } catch (error) {
      return spotSwapErrorResponse(error, "Quote failed. Please try again.", "/api/spot-swap-quote");
    }
  });
}
