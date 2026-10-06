import bs58 from "bs58";
import { apiError } from "@/lib/api-response";
import { rpcConnection } from "@/lib/rpc";

export async function POST(request: Request) {
  try {
    const body: unknown = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Invalid transaction verification input");
    const { signature, lastValidBlockHeight } = body as Record<string, unknown>;
    if (typeof signature !== "string" || bs58.decode(signature).length !== 64 ||
      !Number.isSafeInteger(lastValidBlockHeight) || (lastValidBlockHeight as number) <= 0) {
      throw new Error("Invalid transaction verification input");
    }
    const connection = rpcConnection();
    const observed = (await connection.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0];
    let status: "finalized" | "failed" | "pending" | "expired";
    if (observed?.confirmationStatus === "finalized") status = observed.err ? "failed" : "finalized";
    else if (observed) status = "pending";
    else status = (await connection.getBlockHeight("confirmed")) > (lastValidBlockHeight as number) ? "expired" : "pending";
    return Response.json({ status }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return apiError(error, "Transaction verification failed"); }
}
