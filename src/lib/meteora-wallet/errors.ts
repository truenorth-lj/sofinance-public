import { couldntSendLine, isWalletRejection, walletWords } from "@/lib/tx-pipeline/errors";

/** Plain-words messages for the Meteora open panel. Server "blocked" messages are already plain and pass through. */
export function meteoraPlainError(error: unknown, context: "sign" | "send" | "prepare" | "network" = "prepare"): string {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  // Only an explicit wallet rejection says "cancelled" (shared rule, `isWalletRejection`): an adapter's error class name
  // (WalletSignTransactionError) wraps every wallet failure, not just a "no".
  if (context !== "send" && isWalletRejection(error)) return "You cancelled the request in your wallet. Nothing was sent.";
  // Any other wallet failure while signing, or the relay refusing the signed transaction ("send": it never reached the
  // network), is a send failure with a plain reason, never a cancel.
  if (context === "sign" || context === "send") return `${couldntSendLine(error, context === "sign" ? "wallet" : "network")} Nothing was sent.`;
  return plainReason(message, context);
}

function plainReason(message: string, context: "sign" | "send" | "prepare" | "network"): string {
  if (/^Not enough /.test(message)) return message;
  if (/expired/i.test(message)) return "The transaction expired before it was sent. Please prepare it again.";
  if (/Simulation failed|simulation/i.test(message)) return "The transaction would fail right now (the price moved or a balance changed). Nothing was sent. Please prepare it again.";
  if (/more SOL than estimated/i.test(message)) return message;
  if (/Failed to fetch|NetworkError|Load failed/i.test(message) || context === "network") return "Could not reach SoFinance. Check your connection and try again.";
  if (/bin array/i.test(message) || /SOL input/i.test(message) || /Protocol fee account/i.test(message)) return message;
  const words = walletWords(message);
  return words ? `Something went wrong: ${words}.` : "Something went wrong. Please try again.";
}

export function meteoraFailedOnChainMessage(kind: "setup" | "deposit" | "close"): string {
  if (kind === "setup") return "Step 1/2 failed on chain. No position was created and no rent was kept (only the network fee). You can try again.";
  if (kind === "deposit") return "Step 2/2 failed on chain. Your tokens stayed in your wallet. Retry 2/2, or close the empty position to get its rent back.";
  return "Closing failed on chain. The position is still yours; please try again.";
}

export const solscanTxUrl = (signature: string) => `https://solscan.io/tx/${signature}`;
