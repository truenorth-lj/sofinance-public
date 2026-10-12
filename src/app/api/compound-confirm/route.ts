import { PublicKey } from "@solana/web3.js";
import type { ParsedTransactionWithMeta } from "@solana/web3.js";
import { readCompoundBody } from "@/lib/compound-api";
import { parseWallet } from "@/lib/api-input";
import { parseCompoundAttempt } from "@/lib/compound-attempt";
import { readCompoundPositionState } from "@/lib/compound-state";
import { confirmedCompoundReceipt, confirmedRecovery } from "@/lib/compound-receipt";
import { rpcConnection } from "@/lib/rpc";
import { apiError } from "@/lib/api-response";
import type { CompoundChainStatus } from "@/lib/compound-types";

export async function POST(request: Request) {
  try {
    const body = await readCompoundBody(request);
    const wallet = parseWallet(body.wallet);
    const attempt = parseCompoundAttempt(body.attempt, wallet);
    if (!attempt) throw new Error("Invalid compound verification record");
    const connection = rpcConnection();
    const observed = (await connection.getSignatureStatuses([attempt.signature], { searchTransactionHistory: true })).value[0];
    const base = { signature: attempt.signature, state: null };
    const respond = (value: object, chainStatus: CompoundChainStatus) => Response.json({ ...base, ...value, chainStatus },
      { headers: { "Cache-Control": "no-store" } });
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
      catch { return respond({ status: "manual-review" }, "success"); }
    }
    if (!transaction?.meta || transaction.transaction.signatures[0] !== attempt.signature) {
      return respond({ status: "manual-review" }, "success");
    }
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
  } catch (error) { return apiError(error, "Compound transaction verification failed"); }
}
