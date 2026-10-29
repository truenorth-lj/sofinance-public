import { ComputeBudgetProgram, TransactionMessage, VersionedTransaction, type AddressLookupTableAccount } from "@solana/web3.js";
import { PREPARE_STALE_MS, QUOTE_TTL_MS } from "./ids";

export function quoteWindow(now = Date.now()) {
  return { simulatedAt: now, expiresAt: now + QUOTE_TTL_MS };
}

export function preparedAtMs(summary: { simulatedAt?: number; expiresAt: number }) {
  return Number.isFinite(summary.simulatedAt) ? summary.simulatedAt as number : summary.expiresAt - QUOTE_TTL_MS;
}

export function prepareIsStale(summary: { simulatedAt?: number; expiresAt: number }, now = Date.now()) {
  return now - preparedAtMs(summary) >= PREPARE_STALE_MS;
}

export function stampPreparedBlockhash(
  latest: { blockhash: string; lastValidBlockHeight: number },
  now = Date.now(),
) {
  return { blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight, ...quoteWindow(now) };
}

/** Rebuild the compiled message with a later blockhash. Instruction keys and ALTs stay the same. */
export function restampVersionedTransaction(
  transaction: VersionedTransaction,
  blockhash: string,
  tables: AddressLookupTableAccount[] = [],
  options: { computeUnitLimit?: number } = {},
) {
  const compiled = TransactionMessage.decompile(transaction.message, { addressLookupTableAccounts: tables });
  let instructions = compiled.instructions;
  if (options.computeUnitLimit !== undefined) {
    // Replace the existing SetComputeUnitLimit (same position, so account order and ALTs are unchanged).
    const index = instructions.findIndex((ix) => ix.programId.equals(ComputeBudgetProgram.programId) && ix.data[0] === 2);
    if (index < 0) throw new Error("Transaction is missing its compute-unit limit");
    instructions = instructions.map((ix, at) => at === index
      ? ComputeBudgetProgram.setComputeUnitLimit({ units: options.computeUnitLimit! }) : ix);
  }
  const restamped = new VersionedTransaction(new TransactionMessage({
    payerKey: compiled.payerKey, recentBlockhash: blockhash, instructions,
  }).compileToV0Message(tables));
  if (restamped.message.recentBlockhash !== blockhash) throw new Error("Failed to restamp transaction blockhash");
  return restamped;
}
