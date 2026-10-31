import "@/lib/engine-host";
import { createHash } from "node:crypto";
import { VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { apiError } from "@/lib/api-response";
import { getSigningSecret } from "@sofinance/engine/config/server-env";
import { rpcConnection } from "@sofinance/engine/rpc";
import { exceedsTxSizeLimit } from "@sofinance/engine/transaction-limits";
import { cacheLandedResult, cachedLandedResult } from "@/lib/tx-landed/cache";
import { findLandedTransaction, LandedCheckWindowClosedError, LANDED_REQUEST_BUDGET_MS } from "@/lib/tx-landed/lookup";
import { verifyTxLandedPermit } from "@/lib/tx-send/permit";
import { clientIp, txLandedCheckRateLimited, txLandedRateLimited } from "@/lib/tx-send/rate-limit";

const NO_STORE = { "Cache-Control": "no-store" } as const;
const MAX_BASE64 = 2_500;
/** Signatures older than this before the client's prepare time are never this attempt (allows clock skew). */
const SKEW_SECONDS = 120;
/**
 * The scan always reaches back at least this far from the SERVER clock, whatever the browser's clock says: a
 * browser clock running fast must not end the scan early and have it counted as complete.
 */
const MIN_LOOKBACK_SECONDS = 300;
const MAX_LOOKBACK_SECONDS = 15 * 60;

/**
 * Read-only: did the transaction we prepared land after the wallet reported an error? Only for transactions this
 * app prepared, with a check permit that also signs the prepare-time `lastValidBlockHeight` (so the window cannot
 * be stretched), refused once that blockhash is long expired, rate limited per IP, per check and per wallet, with
 * a per-request RPC/time budget. It never sends anything. See `findLandedTransaction` for when "not-landed" may be returned.
 */
export async function POST(request: Request) {
  if (txLandedRateLimited(clientIp(request))) return tooMany();
  let input: Parameters<typeof findLandedTransaction>[1];
  let key: string;
  try {
    const body = await request.json() as Record<string, unknown> | null;
    const { unsignedTransaction, landedPermit, lastValidBlockHeight, preparedAt, checked } = body ?? {};
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
    if (!wallet || !verifyTxLandedPermit(getSigningSecret(), wallet, bytes, lastValidBlockHeight, landedPermit)) {
      throw new Error("This transaction was not prepared by SoFinance");
    }
    if (txLandedCheckRateLimited(landedPermit as string, wallet)) return tooMany();
    const now = Math.floor(Date.now() / 1000);
    const clientPrepared = Math.floor((preparedAt as number) / 1000) - SKEW_SECONDS;
    const notBefore = Math.max(now - MAX_LOOKBACK_SECONDS, Math.min(now - MIN_LOOKBACK_SECONDS, clientPrepared));
    input = { wallet, prepared, lastValidBlockHeight: lastValidBlockHeight as number, notBefore, checked: checked as string[] | undefined };
    key = `${landedPermit as string}:${createHash("sha256").update(JSON.stringify(checked ?? [])).digest("hex")}`;
  } catch (error) {
    return apiError(error, "Transaction check failed", 400);
  }
  const hit = cachedLandedResult(key);
  if (hit) return Response.json(hit, { headers: NO_STORE });
  try {
    const result = await findLandedTransaction(rpcConnection(), { ...input, deadline: Date.now() + LANDED_REQUEST_BUDGET_MS });
    cacheLandedResult(key, result);
    return Response.json(result, { headers: NO_STORE });
  } catch (error) {
    // Long past expiry: the browser stops asking and says it could not confirm (never "not landed").
    if (error instanceof LandedCheckWindowClosedError) return Response.json({ error: error.message }, { status: 410, headers: NO_STORE });
    // RPC trouble: the browser keeps polling and never treats this as "not landed". Not reported per poll.
    return Response.json({ error: "Could not check Solana right now" }, { status: 502, headers: NO_STORE });
  }
}

function tooMany() {
  return Response.json({ error: "Too many checks. Wait a moment and try again." }, { status: 429, headers: { ...NO_STORE, "Retry-After": "10" } });
}
