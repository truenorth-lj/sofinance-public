import "@/lib/engine-host";
import { PublicKey } from "@solana/web3.js";
import { parseWallet } from "@sofinance/engine/api-input";
import { withJupiterRelay } from "@/lib/jupiter-relay-route";
import { loadSpotSwapStockContext } from "@/lib/stock-market/source";
import { jsonObject, parseRawMinOut, parseSpotSwapAmount, parseUnderlying } from "@/lib/stock-market/public";
import { json } from "@/lib/api/route";
import { SPOT_SWAP_UNAVAILABLE_MESSAGE, spotSwapErrorResponse } from "@/lib/stock-market/spot-swap-response";
import { prepareSpotSwapForStock } from "@/server/transactions/spot-swap";

const INVALID = "This purchase request is not valid. Nothing was prepared.";
const FALLBACK = "Couldn't prepare the purchase. Nothing was sent; please try again.";

/**
 * Builds and simulates the USDC -> stock token swap for the user's wallet (only signer). The mint must be in the
 * server's allowlist for this stock; the engine re-checks fee, spend, minimum out and signers before returning bytes.
 * `minOut` is the minimum the user confirmed: a route below it returns the new terms instead of bytes to sign.
 */
export async function POST(request: Request) {
  let body: Record<string, unknown> | null;
  try { body = jsonObject(await request.clone().json()); } catch { body = null; }
  if (!body) return json({ error: INVALID }, 400);
  const underlying = parseUnderlying(body.underlying);
  const amount = parseSpotSwapAmount(body.amount);
  // The minimum the user saw and confirmed; the built route must not go below it.
  const minOut = parseRawMinOut(body.minOut);
  let wallet: string;
  let mint: string;
  try {
    wallet = parseWallet(body.wallet);
    if (typeof body.mint !== "string") throw new Error("mint");
    mint = new PublicKey(body.mint).toBase58();
  } catch { return json({ error: INVALID }, 400); }
  if (!underlying || !amount || minOut === null) return json({ error: INVALID }, 400);
  let context;
  try { context = await loadSpotSwapStockContext(underlying); } catch (error) { return spotSwapErrorResponse(error, FALLBACK, "/api/spot-swap-prepare"); }
  if (!context) return json({ error: SPOT_SWAP_UNAVAILABLE_MESSAGE, code: "spot_swap_unavailable" }, 404);
  return withJupiterRelay(request, async () => {
    try {
      return json(await prepareSpotSwapForStock(context, wallet, mint, amount, minOut));
    } catch (error) {
      return spotSwapErrorResponse(error, FALLBACK, "/api/spot-swap-prepare");
    }
  });
}
