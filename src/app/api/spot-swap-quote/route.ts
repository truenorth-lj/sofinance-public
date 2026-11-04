import "@/lib/engine-host";
import { parseWallet } from "@sofinance/engine/api-input";
import { withJupiterRelay } from "@/lib/jupiter-relay-route";
import { loadSpotSwapStockContext } from "@/lib/stock-market/source";
import { parseSpotSwapAmount, parseUnderlying } from "@/lib/stock-market/public";
import { SPOT_SWAP_UNAVAILABLE_MESSAGE, spotSwapErrorResponse } from "@/lib/stock-market/spot-swap-response";
import { quoteSpotSwapForStock } from "@/server/transactions/spot-swap";

const NO_STORE = { "Cache-Control": "no-store" } as const;
const INVALID = "Enter a USDC amount with up to 6 decimals.";

/**
 * Read-only quote for the homepage Buy modal: the engine picks the issuer for this amount, the price-impact cap and
 * the fee come from the engine, and with a wallet the SOL / USDC readiness is checked. Nothing is built or signed.
 */
export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try { body = await request.clone().json() as Record<string, unknown>; } catch { return Response.json({ error: INVALID }, { status: 400, headers: NO_STORE }); }
  const underlying = parseUnderlying(body.underlying);
  const amount = parseSpotSwapAmount(body.amount);
  if (!underlying || !amount) return Response.json({ error: INVALID }, { status: 400, headers: NO_STORE });
  let wallet: string | null = null;
  if (body.wallet !== undefined && body.wallet !== null) {
    try { wallet = parseWallet(body.wallet); } catch { return Response.json({ error: "Wallet address is not valid." }, { status: 400, headers: NO_STORE }); }
  }
  // Outside the relay: a cache miss here calls Jupiter search, which the browser relay does not carry.
  let context;
  try { context = await loadSpotSwapStockContext(underlying); } catch (error) { return spotSwapErrorResponse(error, "Quote failed. Please try again.", "/api/spot-swap-quote"); }
  if (!context) return Response.json({ error: SPOT_SWAP_UNAVAILABLE_MESSAGE, code: "spot_swap_unavailable" }, { status: 404, headers: NO_STORE });
  return withJupiterRelay(request, async () => {
    try {
      return Response.json(await quoteSpotSwapForStock(context, amount, wallet), { headers: NO_STORE });
    } catch (error) {
      return spotSwapErrorResponse(error, "Quote failed. Please try again.", "/api/spot-swap-quote");
    }
  });
}
