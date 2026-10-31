import { errorText, mapKnownChainError, sanitizePublicError, TX_EXPIRED_MESSAGE } from "@/lib/public-error";

/**
 * Stage 4 (status): one classification for every Solana flow.
 * - rejected: the user said no in the wallet; stay quiet.
 * - expired:  the blockhash aged out before Solana included it; nothing changed, retry is safe.
 * - not-sent: we know the transaction never reached the network; retry is safe.
 * - failed:   it reached Solana and its on-chain checks failed (slippage, min-out); nothing changed but the fee.
 * - unknown:  anything else; check the explorer before retrying.
 */
export type TxFailureKind = "rejected" | "expired" | "not-sent" | "failed" | "unknown";
export type TxFlow = "add" | "open" | "compound" | "withdraw" | "swap";

export const FLOW_LABEL: Record<TxFlow, string> = {
  add: "Add liquidity", open: "Create position", compound: "Compound", withdraw: "Withdraw", swap: "Swap to tokens",
};

const REJECTED = /user rejected|rejected the request|user declined|declined|cancel+ed by user|request rejected|4001\b/i;
const EXPIRED = /blockhash not found|blockhash expired|block height exceeded|transaction has expired|blockhashNotFound|TransactionExpired/i;

/** A send that failed after we may have handed the signed bytes to the network: track the signature, never resend. */
export class TxSendUnknownError extends Error {
  constructor(readonly signature: string, readonly cause: unknown) {
    super(`We could not confirm the send. Check ${signature.slice(0, 8)}… on Solscan; it may still land.`);
    this.name = "TxSendUnknownError";
  }
}

/** Raised before anything reached the network (prepare failed, wallet refused to send, preflight rejected). */
export class TxNotSentError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "TxNotSentError";
  }
}

export function txFailureKind(error: unknown): TxFailureKind {
  const text = errorText(error);
  if ((error as { name?: string } | null)?.name === "WalletSignTransactionError" && REJECTED.test(text)) return "rejected";
  if (REJECTED.test(text)) return "rejected";
  if (EXPIRED.test(text) || text.includes(TX_EXPIRED_MESSAGE)) return "expired";
  if (error instanceof TxSendUnknownError) return "unknown";
  // Relay timeouts arrive wrapped in TxSendUnknownError, so a bare timeout happened before sending.
  if (isTimeout(error)) return "not-sent";
  if (error instanceof TxNotSentError || (error as { sent?: unknown } | null)?.sent === false) return "not-sent";
  return "unknown";
}

function isTimeout(error: unknown) {
  return (error as { name?: string } | null)?.name === "TimeoutError" || /aborted due to timeout|timed out/i.test(errorText(error));
}

/** Retrying is safe whenever we know nothing landed. */
export const canRetry = (kind: TxFailureKind) => kind === "expired" || kind === "not-sent" || kind === "failed";

/** Plain words for the person in front of the wallet. Never raw RPC text, never secrets. */
export function plainTxError(error: unknown, kind = txFailureKind(error)): string {
  if (kind === "rejected") return "You cancelled in your wallet. Nothing was sent.";
  if (kind === "expired") return TX_EXPIRED_MESSAGE;
  if (error instanceof TxSendUnknownError) return error.message;
  if (kind === "not-sent" && isTimeout(error)) return "Preparing the transaction timed out. Nothing was sent; try again.";
  const known = mapKnownChainError(errorText(error));
  const message = known ?? sanitizePublicError(error, "The transaction could not be completed.");
  if (kind === "not-sent" && !/nothing was sent|not sent/i.test(message)) return `${message}${/[.!?]$/.test(message) ? "" : "."} Nothing was sent.`;
  return message;
}
