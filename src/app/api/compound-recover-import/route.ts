import "@/lib/engine-host";
import bs58 from "bs58";
import { parseWallet } from "@sofinance/engine/api-input";
import { readCompoundBody } from "@/lib/compound-api";
import { importCompoundReceipt } from "@/lib/dex";
import { rpcConnection } from "@sofinance/engine/rpc";
import { apiError } from "@/lib/api-response";

export async function POST(request: Request) {
  try {
    const body = await readCompoundBody(request);
    const wallet = parseWallet(body.wallet);
    if (typeof body.signature !== "string" || bs58.decode(body.signature).length !== 64) throw new Error("Invalid compound transaction signature");
    const connection = rpcConnection();
    const receipt = await importCompoundReceipt("raydium-clmm", { wallet, signature: body.signature }, connection);
    return Response.json({ receipt }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return apiError(error, "Failed to recover harvest accounts from chain"); }
}
