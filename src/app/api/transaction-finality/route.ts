import "@/lib/engine-host";
import bs58 from "bs58";
import { apiError } from "@/lib/api-response";
import { rpcConnection } from "@sofinance/engine/rpc";

/**
 * Read-only signature status. With `commitment: "confirmed"` a landed transaction reports
 * "confirmed" as soon as the cluster confirms it (the UI pipeline uses this); otherwise it
 * waits for "finalized". "expired" means Solana never saw the signature and the blockhash
 * window has passed, so it can no longer land.
 */
export async function POST(request: Request) {
  try {
    const body: unknown = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Invalid transaction verification input");
    const { signature, lastValidBlockHeight, commitment } = body as Record<string, unknown>;
    if (typeof signature !== "string" || bs58.decode(signature).length !== 64 ||
      !Number.isSafeInteger(lastValidBlockHeight) || (lastValidBlockHeight as number) <= 0 ||
      (commitment !== undefined && commitment !== "confirmed" && commitment !== "finalized")) {
      throw new Error("Invalid transaction verification input");
    }
    const connection = rpcConnection();
    const observed = (await connection.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0];
    let status: "finalized" | "confirmed" | "failed" | "pending" | "expired";
    if (observed?.err) status = "failed";
    else if (observed?.confirmationStatus === "finalized") status = "finalized";
    else if (commitment === "confirmed" && observed?.confirmationStatus === "confirmed") status = "confirmed";
    else if (observed) status = "pending";
    else status = (await connection.getBlockHeight("confirmed")) > (lastValidBlockHeight as number) ? "expired" : "pending";
    return Response.json({ status }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return apiError(error, "Transaction verification failed"); }
}
