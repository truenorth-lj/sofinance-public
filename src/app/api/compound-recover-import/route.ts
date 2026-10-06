import bs58 from "bs58";
import { parseWallet } from "@/lib/api-input";
import { readCompoundBody } from "@/lib/compound-api";
import { importVerifiedCompoundReceipt } from "@/lib/compound-recovery-import";
import { rpcConnection } from "@/lib/rpc";
import { apiError } from "@/lib/api-response";

export async function POST(request: Request) {
  try {
    const body = await readCompoundBody(request);
    const wallet = parseWallet(body.wallet);
    if (typeof body.signature !== "string" || bs58.decode(body.signature).length !== 64) throw new Error("Invalid compound transaction signature");
    const connection = rpcConnection();
    const transaction = await connection.getParsedTransaction(body.signature, { commitment: "finalized", maxSupportedTransactionVersion: 0 });
    if (!transaction) throw new Error("Confirmed original compound transaction not yet found");
    const receipt = await importVerifiedCompoundReceipt(connection, transaction, wallet, body.signature);
    return Response.json({ receipt }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return apiError(error, "Failed to recover yield accounts from chain"); }
}
