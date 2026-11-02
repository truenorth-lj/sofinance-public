import "@/lib/engine-host";
import { VersionedTransaction } from "@solana/web3.js";
import { apiError } from "@/lib/api-response";
import { getSigningSecret } from "@sofinance/engine/config/server-env";
import { exceedsTxSizeLimit } from "@sofinance/engine/transaction-limits";
import { simulateBeforeWallet } from "@/lib/tx-simulate/simulate.server";
import { verifyTxLandedPermit } from "@/lib/tx-send/permit";
import { clientIp, slidingWindowLimiter } from "@/lib/tx-send/rate-limit";

const NO_STORE = { "Cache-Control": "no-store" } as const;
const MAX_BASE64 = 2_500;
/** A run simulates at most twice per step (first prepare + one re-prepare); room for a few steps a minute. */
const perIp = slidingWindowLimiter(20);

/**
 * Read-only pre-wallet check (tx pipeline preflight): simulates a transaction this app prepared (the prepare-issued
 * check permit covers these bytes) on public RPC, and answers in plain words. It never sends or signs anything.
 */
export async function POST(request: Request) {
  if (perIp.limited(clientIp(request))) {
    return Response.json({ ok: null, unavailable: true }, { status: 429, headers: { ...NO_STORE, "Retry-After": "10" } });
  }
  let transaction: VersionedTransaction;
  try {
    const body = await request.json() as Record<string, unknown> | null;
    const { unsignedTransaction, landedPermit, lastValidBlockHeight } = body ?? {};
    if (typeof unsignedTransaction !== "string" || !unsignedTransaction || unsignedTransaction.length > MAX_BASE64) throw new Error("Invalid simulation input");
    const bytes = Buffer.from(unsignedTransaction, "base64");
    if (exceedsTxSizeLimit(bytes.length)) throw new Error("Invalid simulation input");
    transaction = VersionedTransaction.deserialize(bytes);
    const wallet = transaction.message.staticAccountKeys[0]?.toBase58();
    if (!wallet || !verifyTxLandedPermit(getSigningSecret(), wallet, bytes, lastValidBlockHeight, landedPermit)) {
      throw new Error("This transaction was not prepared by SoFinance");
    }
  } catch (error) {
    return apiError(error, "Transaction simulation failed", 400);
  }
  return Response.json(await simulateBeforeWallet(transaction), { headers: NO_STORE });
}
