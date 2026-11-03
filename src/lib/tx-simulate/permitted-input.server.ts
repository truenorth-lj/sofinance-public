import "server-only";
import { VersionedTransaction } from "@solana/web3.js";
import { getSigningSecret } from "@sofinance/engine/config/server-env";
import { exceedsTxSizeLimit } from "@sofinance/engine/transaction-limits";
import { verifyTxLandedPermit } from "@/lib/tx-send/permit";

export const PERMITTED_TX_MAX_BASE64 = 2_500;

/**
 * Shared input check for the pre-wallet guard routes (`/api/tx-simulate`, `/api/tx-expiry`): the exact bytes this app
 * prepared, covered by the prepare-issued check permit (which also signs `lastValidBlockHeight`). Throws on anything else.
 */
export function parsePermittedTx(body: Record<string, unknown> | null) {
  const { unsignedTransaction, landedPermit, lastValidBlockHeight } = body ?? {};
  if (typeof unsignedTransaction !== "string" || !unsignedTransaction || unsignedTransaction.length > PERMITTED_TX_MAX_BASE64 ||
    typeof landedPermit !== "string" || !landedPermit ||
    !Number.isSafeInteger(lastValidBlockHeight) || (lastValidBlockHeight as number) <= 0) {
    throw new Error("Invalid transaction input");
  }
  const bytes = Buffer.from(unsignedTransaction, "base64");
  if (exceedsTxSizeLimit(bytes.length)) throw new Error("Invalid transaction input");
  const transaction = VersionedTransaction.deserialize(bytes);
  const wallet = transaction.message.staticAccountKeys[0]?.toBase58();
  if (!wallet || !verifyTxLandedPermit(getSigningSecret(), wallet, bytes, lastValidBlockHeight, landedPermit)) {
    throw new Error("This transaction was not prepared by SoFinance");
  }
  return { transaction, wallet, landedPermit, lastValidBlockHeight: lastValidBlockHeight as number };
}
