import "@/lib/engine-host";
import "server-only";
import { PublicKey, type ParsedTransactionWithMeta } from "@solana/web3.js";
import { readCompoundPositionState } from "@sofinance/engine/compound-state";
import type { CompoundChainStatus } from "@sofinance/engine/compound-types";
import { confirmedCompoundReceipt, confirmedRecovery } from "@/lib/compound-receipt";
import { invalidatePositionHistoryCache } from "@/lib/position-history-cache";
import { resetRpcCache } from "@sofinance/engine/rpc/cache";
import type { ConfirmCompound, CompoundConfirmationResult } from "../compound-read";

/** Finalized execution evidence and ledger evidence remain separate; never builds or sends. */
export const confirmRaydiumCompound: ConfirmCompound = async ({ wallet, attempt }, connection) => {
    const observed = (await connection.getSignatureStatuses([attempt.signature], { searchTransactionHistory: true })).value[0];
    const base = { signature: attempt.signature, state: null };
    const respond = (value: Pick<CompoundConfirmationResult, "status"> &
      Partial<Pick<CompoundConfirmationResult, "state" | "receipt" | "transactionError">>, chainStatus: CompoundChainStatus): CompoundConfirmationResult => {
      if (chainStatus === "success") {
        invalidatePositionHistoryCache(attempt.positionMint);
        resetRpcCache();
      }
      return { ...base, ...value, chainStatus };
    };
    // Some providers cannot find older signatures even with searchTransactionHistory.
    // A finalized historical transaction is stronger evidence than today's account balances.
    let transaction: ParsedTransactionWithMeta | null = null;
    if (!observed) {
      transaction = await connection.getParsedTransaction(attempt.signature, { commitment: "finalized", maxSupportedTransactionVersion: 0 });
      if (transaction && transaction.transaction.signatures[0] !== attempt.signature) {
        return respond({ status: "manual-review" }, "unknown");
      }
    }
    if (!observed && !transaction?.meta) {
      const height = await connection.getBlockHeight("finalized");
      if (height <= attempt.summary.lastValidBlockHeight) return respond({ status: "pending" }, "pending");
      // Account creation/closure is additional evidence, not a substitute for
      // the signature. A changed account without transaction evidence needs review.
      const accounts = await connection.getMultipleAccountsInfo(attempt.summary.compoundAccounts.map((account) => new PublicKey(account.address)), "confirmed");
      const unchanged = attempt.kind === "compound" ? accounts.every((account) => account === null) : accounts.every((account) => account !== null);
      return respond({ status: unchanged ? "expired" : "manual-review" }, unchanged ? "expired" : "unknown");
    }
    if (observed && observed.confirmationStatus !== "finalized") return respond({ status: "pending" }, "pending");
    if (observed?.err) return respond({ status: "failed", transactionError: observed.err }, "failed");
    if (!transaction) {
      try { transaction = await connection.getParsedTransaction(attempt.signature, { commitment: "finalized", maxSupportedTransactionVersion: 0 }); }
      // Finality is known, but history providers can lag or time out. Keep
      // checking the original signature until its receipt can be verified.
      catch { return respond({ status: "pending" }, "success"); }
    }
    if (transaction && transaction.transaction.signatures[0] !== attempt.signature) {
      return respond({ status: "manual-review" }, "success");
    }
    if (!transaction?.meta) return respond({ status: "pending" }, "success");
    if (transaction.meta.err) return respond({ status: "failed", transactionError: transaction.meta.err }, "failed");
    if (attempt.kind === "recovery") {
      let verified = false;
      try { verified = confirmedRecovery(transaction, wallet, attempt.summary); } catch { /* Execution is already finalized. */ }
      return respond({ status: verified ? "success" : "manual-review" }, "success");
    }
    let receipt: ReturnType<typeof confirmedCompoundReceipt> = null;
    try { receipt = confirmedCompoundReceipt(transaction, wallet, attempt.summary); } catch { /* Preserve finalized execution certainty when ledger parsing fails. */ }
    let state = null;
    if (receipt) {
      // Newer pool/position changes must not erase proof of a successful past
      // compound. Its ledger comes from this transaction's metadata.
      try { state = await readCompoundPositionState(wallet, attempt.positionMint, connection); } catch { /* Keep the historical receipt. */ }
    }
    return respond({ state, receipt, status: receipt ? "success" : "manual-review" }, "success");
};
