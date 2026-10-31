import { VersionedTransaction } from "@solana/web3.js";
import { TxNotSentError } from "@/lib/tx-pipeline";

/** Decode a prepared base64 transaction and check it pays from this wallet. */
export function decodePreparedTransaction(base64: string, wallet: string, blockhash?: string) {
  const transaction = VersionedTransaction.deserialize(Uint8Array.from(atob(base64), (character) => character.charCodeAt(0)));
  if (transaction.message.staticAccountKeys[0]?.toBase58() !== wallet ||
    (blockhash !== undefined && transaction.message.recentBlockhash !== blockhash)) {
    throw new TxNotSentError("The prepared transaction does not match your wallet. Nothing was sent.");
  }
  return transaction;
}

