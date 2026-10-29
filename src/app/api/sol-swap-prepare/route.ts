import "@/lib/engine-host";
import { PublicKey } from "@solana/web3.js";
import { parseWallet } from "@sofinance/engine/api-input";
import { withJupiterRelay } from "@/lib/jupiter-relay-route";
import { apiError } from "@/lib/api-response";
import { prepareSolSwapStep } from "@/server/transactions/sol-swap-step";

/** Step 1/2 of a SOL deposit: SOL -> pool token swap (fee inside the swap). */
export async function POST(request: Request) {
  return withJupiterRelay(request, async () => {
    try {
      const body = await request.json() as Record<string, unknown>;
      const wallet = parseWallet(body.wallet);
      if (typeof body.poolId !== "string" || typeof body.amount !== "string" || body.amount.length > 40) {
        throw new Error("Invalid pool or input amount");
      }
      let poolId: string;
      try { poolId = new PublicKey(body.poolId).toBase58(); } catch { throw new Error("Invalid pool or input amount"); }
      const prepared = await prepareSolSwapStep(wallet, poolId, body.amount);
      return Response.json(prepared, { headers: { "Cache-Control": "no-store" } });
    } catch (error) {
      return apiError(error, "SOL swap preparation failed");
    }
  });
}
