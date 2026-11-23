import "@/lib/engine-host";
import { apiError } from "@/lib/api-response";
import { rpcConnection } from "@sofinance/engine/rpc";
import { NO_STORE_HEADERS } from "@/lib/http/no-store";
import { isSolanaSignature, readSignatureFinality } from "@/lib/transaction-finality";

/**
 * Read-only signature status (`readSignatureFinality`, shared with the MCP `tx_status` tool). With
 * `commitment: "confirmed"` a landed transaction reports "confirmed" as soon as the cluster confirms it (the UI
 * pipeline uses this); otherwise it waits for "finalized". "expired" means Solana never saw the signature and the
 * blockhash window has passed, so it can no longer land.
 */
export async function POST(request: Request) {
  try {
    const body: unknown = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Invalid transaction verification input");
    const { signature, lastValidBlockHeight, commitment } = body as Record<string, unknown>;
    if (!isSolanaSignature(signature) ||
      !Number.isSafeInteger(lastValidBlockHeight) || (lastValidBlockHeight as number) <= 0 ||
      (commitment !== undefined && commitment !== "confirmed" && commitment !== "finalized")) {
      throw new Error("Invalid transaction verification input");
    }
    const { status } = await readSignatureFinality(rpcConnection(), {
      signature, lastValidBlockHeight: lastValidBlockHeight as number, commitment,
    });
    return Response.json({ status }, { headers: NO_STORE_HEADERS });
  } catch (error) { return apiError(error, "Transaction verification failed"); }
}
