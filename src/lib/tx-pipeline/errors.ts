import { errorText, mapKnownChainError, sanitizePublicError, TX_EXPIRED_MESSAGE } from "@/lib/public-error";
import type { LandedOutcome } from "./landed";

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

/**
 * Explicit rejection wording. A wallet error that carries a numeric code is a rejection only for EIP-1193 /
 * Phantom code 4001: Phantom has thrown `{"code":400,"message":"Request … rejected by user"}` AFTER it
 * broadcast the transaction, so the words alone never prove that nothing was sent.
 */
const REJECTED = /user rejected|rejected the request|user declined|rejected by (the )?user|cancel+ed by (the )?user|request rejected|user cancel+ed/i;
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

/**
 * The wallet threw after we asked it to sign and send, and the chain lookup then confirmed the transaction
 * did not land before its blockhash expired. Only this error may say "Nothing was sent, safe to retry".
 */
export class TxNotLandedError extends TxNotSentError {
  constructor(readonly walletRejected: boolean, cause: unknown) {
    super(walletRejected
      ? "You cancelled in your wallet. We checked Solana and it did not go through. Nothing was sent, safe to retry."
      : `Your wallet reported a problem${walletReason(cause)}. We checked Solana and it did not go through. Nothing was sent, safe to retry.`, cause);
    this.name = "TxNotLandedError";
  }
}

/** The wallet threw after we asked it to send, and we could not tell whether it landed. Never safe to retry blindly. */
export class TxLandedUnknownError extends Error {
  constructor(readonly cause: unknown) {
    super(`Your wallet reported a problem${walletReason(cause)}, and we could not confirm whether the transaction went through. Check your wallet activity on Solscan before trying again.`);
    this.name = "TxLandedUnknownError";
  }
}

let cancelSequence = 0;

/**
 * The person cancelled in the wallet (an exact code 4001 only; cancel wording without that code, or any other code
 * such as Phantom's 400 "rejected by user", is checked on Solana first instead) after we asked it to
 * sign AND send. We say so at once and unlock the form, but a wallet can broadcast and still report a cancel, so
 * `landed` keeps checking Solana silently until the blockhash expires (see `watchCancelledSend`). It never says
 * "nothing was sent": that is not known yet. `attemptId` keys this attempt's toast, so a resubmit never overwrites it.
 */
export class TxWalletCancelledError extends Error {
  readonly attemptId = `${Date.now().toString(36)}-${++cancelSequence}`;
  constructor(readonly cause: unknown, readonly landed: Promise<LandedOutcome>) {
    super("You cancelled in your wallet.");
    this.name = "TxWalletCancelledError";
  }
}

export type WalletErrorInfo = { code?: number; message: string };

/**
 * A wallet's thrown value in plain parts. Wallets throw Error objects with `code`, plain `{code, message}`
 * objects, or an Error whose message is that object as JSON; this never returns JSON.
 */
export function walletErrorInfo(error: unknown): WalletErrorInfo {
  const seen = new Set<unknown>();
  const read = (value: unknown): WalletErrorInfo => {
    if (value === null || value === undefined || seen.has(value)) return { message: "" };
    seen.add(value);
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed.startsWith("{")) { try { return read(JSON.parse(trimmed)); } catch { return { message: "" }; } }
      return { message: trimmed };
    }
    if (typeof value !== "object") return { message: String(value) };
    const record = value as { code?: unknown; message?: unknown; error?: unknown; cause?: unknown };
    const inner = read(record.message);
    const code = typeof record.code === "number" ? record.code
      : typeof record.code === "string" && /^-?\d+$/.test(record.code) ? Number(record.code) : inner.code;
    // Wallet adapters wrap the wallet's own error (WalletSendTransactionError.error); its code still counts.
    const nested = read(record.error ?? record.cause);
    return { code: code ?? nested.code, message: inner.message || nested.message };
  };
  return read(error);
}

/** Only an explicit rejection: code 4001, or rejection wording on an error with no other code. */
export function isWalletRejection(error: unknown): boolean {
  const info = walletErrorInfo(error);
  if (info.code !== undefined) return info.code === 4001;
  return REJECTED.test(info.message);
}

/** " (“…”)" with the wallet's own words, request ids and JSON stripped; empty when there is nothing readable. */
function walletReason(error: unknown) {
  const message = walletErrorInfo(error).message
    .replace(/\b(request)\s+[0-9a-f-]{8,}\s*/gi, "$1 ").replace(/[{}"[\]]/g, "").replace(/\s+/g, " ").trim().slice(0, 120);
  return message ? ` (“${message.replace(/[.\s]+$/, "")}”)` : "";
}

export function txFailureKind(error: unknown): TxFailureKind {
  if (error instanceof TxNotLandedError) return "not-sent";
  if (error instanceof TxLandedUnknownError) return "unknown";
  if (error instanceof TxWalletCancelledError) return "rejected";
  const text = errorText(error);
  if (isWalletRejection(error)) return "rejected";
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
  if (error instanceof TxNotLandedError || error instanceof TxLandedUnknownError || error instanceof TxWalletCancelledError) return error.message;
  if (kind === "rejected") return "You cancelled in your wallet. Nothing was sent.";
  if (kind === "expired") return TX_EXPIRED_MESSAGE;
  if (error instanceof TxSendUnknownError) return error.message;
  if (kind === "not-sent" && isTimeout(error)) return "Preparing the transaction timed out. Nothing was sent; try again.";
  const known = mapKnownChainError(errorText(error));
  const message = noJson(known ?? sanitizePublicError(error, "The transaction could not be completed."), error);
  if (kind === "not-sent" && !/nothing was sent|not sent/i.test(message)) return `${message}${/[.!?]$/.test(message) ? "" : "."} Nothing was sent.`;
  return message;
}

/** Never show raw JSON: fall back to the wallet's own words, or a plain sentence. */
function noJson(message: string, error: unknown) {
  if (!/[{}[\]]|"\w+"\s*:/.test(message)) return message;
  const reason = walletReason(error);
  return reason ? `Your wallet reported a problem${reason}.` : "The transaction could not be completed.";
}
