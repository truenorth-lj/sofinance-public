import "@/lib/engine-host";
import { PublicKey } from "@solana/web3.js";
import { parseWallet } from "@sofinance/engine/api-input";
import { withJupiterRelay } from "@/lib/jupiter-relay-route";
import { loadSpotSwapStockContext } from "@/lib/stock-market/source";
import { parseSpotSwapAmount, parseUnderlying } from "@/lib/stock-market/public";
import { SPOT_SWAP_UNAVAILABLE_MESSAGE, spotSwapErrorResponse } from "@/lib/stock-market/spot-swap-response";
import { prepareSpotSwapForStock } from "@/server/transactions/spot-swap";

const NO_STORE = { "Cache-Control": "no-store" } as const;
const INVALID = "This purchase request is not valid. Nothing was prepared.";
const FALLBACK = "Couldn't prepare the purchase. Nothing was sent; please try again.";

/**
 * Builds and simulates the USDC -> stock token swap for the user's wallet (only signer). The mint must be in the
 * server's allowlist for this stock; the engine re-checks fee, spend, minimum out and signers before returning bytes.
 */
export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try { body = await request.clone().json() as Record<string, unknown>; } catch { return Response.json({ error: INVALID }, { status: 400, headers: NO_STORE }); }
  const underlying = parseUnderlying(body.underlying);
  const amount = parseSpotSwapAmount(body.amount);
  let wallet: string;
  let mint: string;
  try {
    wallet = parseWallet(body.wallet);
    if (typeof body.mint !== "string") throw new Error("mint");
    mint = new PublicKey(body.mint).toBase58();
  } catch { return Response.json({ error: INVALID }, { status: 400, headers: NO_STORE }); }
  if (!underlying || !amount) return Response.json({ error: INVALID }, { status: 400, headers: NO_STORE });
  let context;
  try { context = await loadSpotSwapStockContext(underlying); } catch (error) { return spotSwapErrorResponse(error, FALLBACK, "/api/spot-swap-prepare"); }
  if (!context) return Response.json({ error: SPOT_SWAP_UNAVAILABLE_MESSAGE, code: "spot_swap_unavailable" }, { status: 404, headers: NO_STORE });
  return withJupiterRelay(request, async () => {
    try {
      return Response.json(await prepareSpotSwapForStock(context, wallet, mint, amount), { headers: NO_STORE });
    } catch (error) {
      return spotSwapErrorResponse(error, FALLBACK, "/api/spot-swap-prepare");
    }
  });
}
