import "@/lib/engine-host";
import { readCompoundBody } from "@/lib/compound-api";
import { parseWallet } from "@sofinance/engine/api-input";
import { parseCompoundAttempt } from "@sofinance/engine/compound-attempt";
import { confirmCompound } from "@/lib/dex";
import { rpcConnection } from "@sofinance/engine/rpc";
import { apiError } from "@/lib/api-response";

export async function POST(request: Request) {
  try {
    const body = await readCompoundBody(request);
    const wallet = parseWallet(body.wallet);
    const attempt = parseCompoundAttempt(body.attempt, wallet);
    if (!attempt) throw new Error("Invalid compound verification record");
    const result = await confirmCompound("raydium-clmm", { wallet, attempt }, rpcConnection());
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return apiError(error, "Compound transaction verification failed"); }
}
