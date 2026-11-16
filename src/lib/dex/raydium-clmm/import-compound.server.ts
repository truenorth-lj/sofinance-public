import "@/lib/engine-host";
import "server-only";
import { importVerifiedCompoundReceipt } from "@sofinance/engine/compound-recovery-import";
import type { ImportCompoundReceipt } from "../compound-read";

export const importRaydiumCompoundReceipt: ImportCompoundReceipt = async ({ wallet, signature }, connection) => {
  const transaction = await connection.getParsedTransaction(signature, { commitment: "finalized", maxSupportedTransactionVersion: 0 });
  if (!transaction) throw new Error("Confirmed original compound transaction not yet found");
  if (transaction.transaction.signatures[0] !== signature) throw new Error("Compound transaction signature mismatch");
  return importVerifiedCompoundReceipt(connection, transaction, wallet, signature);
};
