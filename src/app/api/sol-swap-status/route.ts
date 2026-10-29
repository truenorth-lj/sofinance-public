import "@/lib/engine-host";
import bs58 from "bs58";
import { PublicKey } from "@solana/web3.js";
import { parseWallet } from "@sofinance/engine/api-input";
import { apiError } from "@/lib/api-response";
import { readSolSwapStepStatus } from "@/server/transactions/sol-swap-step";

/** Step 1/2 result: what the swap actually delivered (tx meta), never the quote. */
export async function POST(request: Request) {
  try {
    const body = await request.json() as Record<string, unknown>;
    const wallet = parseWallet(body.wallet);
    const { signature, outputMint, lastValidBlockHeight } = body;
    if (typeof signature !== "string" || bs58.decode(signature).length !== 64 || typeof outputMint !== "string" ||
      !Number.isSafeInteger(lastValidBlockHeight) || (lastValidBlockHeight as number) <= 0) {
      throw new Error("Invalid SOL swap status input");
    }
    const mint = new PublicKey(outputMint).toBase58();
    const result = await readSolSwapStepStatus(wallet, signature, mint, lastValidBlockHeight as number);
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiError(error, "SOL swap status check failed");
  }
}
