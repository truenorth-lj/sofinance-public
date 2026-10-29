/** Plain-words messages for the Meteora open panel. Server "blocked" messages are already plain and pass through. */
export function meteoraPlainError(error: unknown, context: "sign" | "send" | "prepare" | "network" = "prepare"): string {
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  if (/WalletSignTransactionError|WalletNotConnected/.test(name) || /reject|cancel|denied|declined/i.test(message)) {
    return "You cancelled the request in your wallet. Nothing was sent.";
  }
  if (/^Not enough /.test(message)) return message;
  if (/expired/i.test(message)) return "The transaction expired before it was sent. Please prepare it again.";
  if (/Simulation failed|simulation/i.test(message)) return "The transaction would fail right now (the price moved or a balance changed). Nothing was sent. Please prepare it again.";
  if (/more SOL than estimated/i.test(message)) return message;
  if (/Failed to fetch|NetworkError|Load failed/i.test(message) || context === "network") return "Could not reach SoFinance. Check your connection and try again.";
  if (/bin array/i.test(message) || /SOL input/i.test(message) || /Protocol fee account/i.test(message)) return message;
  return message ? `Something went wrong: ${message}` : "Something went wrong. Please try again.";
}

export function meteoraFailedOnChainMessage(kind: "setup" | "deposit" | "close"): string {
  if (kind === "setup") return "Step 1/2 failed on chain. No position was created and no rent was kept (only the network fee). You can try again.";
  if (kind === "deposit") return "Step 2/2 failed on chain. Your tokens stayed in your wallet. Retry 2/2, or close the empty position to get its rent back.";
  return "Closing failed on chain. The position is still yours; please try again.";
}

export const solscanTxUrl = (signature: string) => `https://solscan.io/tx/${signature}`;
