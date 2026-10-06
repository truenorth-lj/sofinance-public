import { PublicKey } from "@solana/web3.js";
import { readCompoundBody } from "@/lib/compound-api";
import { parseWallet } from "@/lib/api-input";
import { parseCompoundAttempt } from "@/lib/compound-attempt";
import { readCompoundPositionState } from "@/lib/compound-state";
import { confirmedCompoundReceipt, confirmedRecovery } from "@/lib/compound-receipt";
import { rpcConnection } from "@/lib/rpc";
import { apiError } from "@/lib/api-response";

export async function POST(request: Request) {
  try {
    const body = await readCompoundBody(request);
    const wallet = parseWallet(body.wallet);
    const attempt = parseCompoundAttempt(body.attempt, wallet);
    if (!attempt) throw new Error("Invalid compound verification record");
    const connection = rpcConnection();
    const observed = (await connection.getSignatureStatuses([attempt.signature], { searchTransactionHistory: true })).value[0];
    const base = { signature: attempt.signature, state: null };
    if (!observed) {
      const height = await connection.getBlockHeight("finalized");
      if (height <= attempt.summary.lastValidBlockHeight) return Response.json({ ...base, status: "pending" }, { headers: { "Cache-Control": "no-store" } });
      // Account creation/closure is additional evidence, not a substitute for
      // the signature. A changed account without transaction evidence needs review.
      const accounts = await connection.getMultipleAccountsInfo(attempt.summary.compoundAccounts.map((account) => new PublicKey(account.address)), "confirmed");
      const unchanged = attempt.kind === "compound" ? accounts.every((account) => account === null) : accounts.every((account) => account !== null);
      return Response.json({ ...base, status: unchanged ? "expired" : "manual-review" }, { headers: { "Cache-Control": "no-store" } });
    }
    if (observed.confirmationStatus !== "finalized") return Response.json({ ...base, status: "pending" }, { headers: { "Cache-Control": "no-store" } });
    if (observed.err) return Response.json({ ...base, status: "failed", transactionError: observed.err }, { headers: { "Cache-Control": "no-store" } });
    const transaction = await connection.getParsedTransaction(attempt.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    if (!transaction || !transaction.meta) return Response.json({ ...base, status: "pending" }, { headers: { "Cache-Control": "no-store" } });
    if (transaction.meta.err) return Response.json({ ...base, status: "failed", transactionError: transaction.meta.err }, { headers: { "Cache-Control": "no-store" } });
    if (attempt.kind === "recovery") {
      return Response.json({ ...base, status: confirmedRecovery(transaction, wallet, attempt.summary) ? "success" : "manual-review" }, { headers: { "Cache-Control": "no-store" } });
    }
    const receipt = confirmedCompoundReceipt(transaction, wallet, attempt.summary);
    let state = null;
    if (receipt) {
      // Newer pool/position changes must not erase proof of a successful past
      // compound. Its ledger comes from this transaction's metadata.
      try { state = await readCompoundPositionState(wallet, attempt.positionMint, connection); } catch { /* Keep the historical receipt. */ }
    }
    return Response.json({ signature: attempt.signature, state, receipt,
      status: receipt ? "success" : "manual-review" }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return apiError(error, "Compound transaction verification failed"); }
}
