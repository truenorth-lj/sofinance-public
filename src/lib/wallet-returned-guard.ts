import "@/lib/engine-host";
import { VersionedTransaction } from "@solana/web3.js";
import { assertWalletReturnedTransaction as assertEngine } from "@sofinance/engine/wallet-returned-tx";
import { captureWalletReturnedTxFailure } from "./sentry/capture";

export { walletReturnedTransactionMatches, walletReturnedTxDiagnostic } from "@sofinance/engine/wallet-returned-tx";

/** App wrapper: engine sanity check, then console + Sentry diagnostic (no secrets). */
export function assertWalletReturnedTransaction(
  prepared: VersionedTransaction,
  signed: VersionedTransaction,
  wallet: string,
) {
  try {
    assertEngine(prepared, signed, wallet);
  } catch (error) {
    captureWalletReturnedTxFailure(error);
    throw error;
  }
}
