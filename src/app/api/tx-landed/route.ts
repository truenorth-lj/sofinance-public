import "@/lib/engine-host";
import { VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { apiError } from "@/lib/api-response";
import { getSigningSecret } from "@sofinance/engine/config/server-env";
import { rpcConnection } from "@sofinance/engine/rpc";
import { exceedsTxSizeLimit } from "@sofinance/engine/transaction-limits";
import { findLandedTransaction } from "@/lib/tx-landed/lookup";
import { verifyTxSendPermit } from "@/lib/tx-send/permit";
import { clientIp, txLandedRateLimited } from "@/lib/tx-send/rate-limit";

const NO_STORE = { "Cache-Control": "no-store" } as const;
const MAX_BASE64 = 2_500;
/** Signatures older than this before the client's prepare time are never this attempt (allows clock skew). */
const SKEW_SECONDS = 120;
const MAX_LOOKBACK_SECONDS = 15 * 60;

/**
 * Read-only: did the transaction we prepared land after the wallet reported an error? Only for
 * transactions this app prepared (same send permit as `/api/tx-send`), rate limited per IP, and it
 * never sends anything. See `findLandedTransaction` for when "not-landed" may be returned.
 */
export async function POST(request: Request) {
  if (txLandedRateLimited(clientIp(request))) {
    return Response.json({ error: "Too many checks. Wait a moment and try again." }, { status: 429, headers: { ...NO_STORE, "Retry-After": "10" } });
  }
  let input: Parameters<typeof findLandedTransaction>[1];
  try {
    const body = await request.json() as Record<string, unknown> | null;
    const { unsignedTransaction, sendPermit, lastValidBlockHeight, preparedAt, checked } = body ?? {};
    if (typeof unsignedTransaction !== "string" || !unsignedTransaction || unsignedTransaction.length > MAX_BASE64 ||
      !Number.isSafeInteger(lastValidBlockHeight) || (lastValidBlockHeight as number) <= 0 ||
      !Number.isFinite(preparedAt) ||
      (checked !== undefined && (!Array.isArray(checked) || checked.length > 200 ||
        !checked.every((item) => typeof item === "string" && item.length <= 90 && bs58.decode(item).length === 64)))) {
      throw new Error("Invalid transaction check input");
    }
    const bytes = Buffer.from(unsignedTransaction, "base64");
    if (exceedsTxSizeLimit(bytes.length)) throw new Error("Invalid transaction check input");
    const prepared = VersionedTransaction.deserialize(bytes);
    const wallet = prepared.message.staticAccountKeys[0]?.toBase58();
    if (!wallet || !verifyTxSendPermit(getSigningSecret(), wallet, bytes, sendPermit)) {
      throw new Error("This transaction was not prepared by SoFinance");
    }
    const now = Math.floor(Date.now() / 1000);
    const prepareSeconds = Math.min(now, Math.max(now - MAX_LOOKBACK_SECONDS, Math.floor((preparedAt as number) / 1000)));
    input = { wallet, prepared, lastValidBlockHeight: lastValidBlockHeight as number,
      notBefore: prepareSeconds - SKEW_SECONDS, checked: checked as string[] | undefined };
  } catch (error) {
    return apiError(error, "Transaction check failed", 400);
  }
  try {
    return Response.json(await findLandedTransaction(rpcConnection(), input), { headers: NO_STORE });
  } catch {
    // RPC trouble: the browser keeps polling and never treats this as "not landed". Not reported per poll.
    return Response.json({ error: "Could not check Solana right now" }, { status: 502, headers: NO_STORE });
  }
}
