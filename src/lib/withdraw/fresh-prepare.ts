/**
 * Restamp a prepared withdraw tx with a blockhash taken at return time (same
 * instructions/ALTs). Engine build fetches the hash before simulation, so the
 * remaining validity window is already shorter by the time the wallet sees it.
 */
import { AddressLookupTableAccount, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { restampVersionedTransaction, stampPreparedBlockhash } from "@sofinance/engine/fresh-blockhash";
import { withdrawPermit } from "@sofinance/engine/withdraw/permit";
import type { WithdrawPrepared } from "@sofinance/engine/withdraw/types";
import { getSigningSecret } from "@sofinance/engine/config/server-env";
import type { Connection } from "@solana/web3.js";

async function lookupTables(connection: Connection, transaction: VersionedTransaction) {
  const keys = transaction.message.addressTableLookups.map((item) => item.accountKey);
  if (keys.length === 0) return [] as AddressLookupTableAccount[];
  const infos = await Promise.all(keys.map((key) => connection.getAddressLookupTable(new PublicKey(key))));
  return infos.flatMap((info) => info.value ? [info.value] : []);
}

export async function refreshWithdrawBlockhash(
  connection: Connection, prepared: WithdrawPrepared,
): Promise<WithdrawPrepared> {
  let transaction: VersionedTransaction;
  try {
    transaction = VersionedTransaction.deserialize(Buffer.from(prepared.unsignedTransaction, "base64"));
  } catch {
    return prepared;
  }
  const latest = await connection.getLatestBlockhash("confirmed");
  const restamped = restampVersionedTransaction(transaction, latest.blockhash, await lookupTables(connection, transaction));
  const summary = { ...prepared.summary, ...stampPreparedBlockhash(latest) };
  const permit = withdrawPermit.issue(getSigningSecret(), {
    wallet: summary.wallet,
    message: Buffer.from(restamped.message.serialize()).toString("base64"),
    summary,
  });
  return { summary, permit, unsignedTransaction: Buffer.from(restamped.serialize()).toString("base64") };
}
