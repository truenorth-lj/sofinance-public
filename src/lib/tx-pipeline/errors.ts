import { errorText, mapKnownChainError, sanitizePublicError, TX_EXPIRED_MESSAGE } from "@/lib/public-error";
import { scrubCredentialText } from "@/lib/sentry/scrub";
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
export type TxFlow = "add" | "open" | "compound" | "withdraw" | "claim" | "swap" | "buy";

export const FLOW_LABEL: Record<TxFlow, string> = {
  add: "Add liquidity", open: "Create position", compound: "Compound", withdraw: "Withdraw", claim: "Claim fees", swap: "Swap to tokens", buy: "Buy stock token",
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

/** The relay's preflight refused the signed transaction: it never reached the network. The message is plain words only. */
export class TxRelayRefusedError extends TxNotSentError {
  constructor(cause: unknown) {
    super(`${couldntSendLine(cause, "network")} Nothing was sent, safe to retry.`, cause);
    this.name = "TxRelayRefusedError";
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
      : `${couldntSendLine(cause)} We checked Solana and it did not go through. Nothing was sent, safe to retry.`, cause);
    this.name = "TxNotLandedError";
  }
}

/** The wallet threw after we asked it to send, and we could not tell whether it landed. Never safe to retry blindly. */
export class TxLandedUnknownError extends Error {
  constructor(readonly cause: unknown) {
    super(`${couldntSendLine(cause)} We could not confirm whether it went through anyway, so check your wallet activity on Solscan before trying again.`);
    this.name = "TxLandedUnknownError";
  }
}

/** A voided prompt whose old transaction we could not settle (landed or expired): the wallet reported nothing wrong. */
export const TX_VOID_UNCONFIRMED_MESSAGE = "We couldn't confirm whether the previous request went through. Check Solscan before trying again.";
export class TxVoidUnconfirmedError extends TxLandedUnknownError {
  constructor(cause: unknown) {
    super(cause);
    this.message = TX_VOID_UNCONFIRMED_MESSAGE;
    this.name = "TxVoidUnconfirmedError";
  }
}

/** Copy for a wallet prompt left unsigned past the pre-wallet guard's deadline (PM 2026-11-02). */
export const TX_PROMPT_EXPIRED_MESSAGE = "This request expired.";
/** Shown while a voided prompt's transaction could still land: Try again stays disabled until its blockhash has expired. */
export const TX_WAITING_PREVIOUS_EXPIRY_COPY = "Waiting for the previous request to expire…";

/**
 * The wallet prompt stayed unsigned past its deadline (about 60 s, or sooner when the blockhash is near expiry), so the
 * pipeline stopped waiting and voided this transaction: a sign-only wallet's late signature is never relayed. Try again
 * prepares a fresh one; nothing is ever resent automatically.
 */
export class TxPromptExpiredError extends Error {
  constructor() {
    super(TX_PROMPT_EXPIRED_MESSAGE);
    this.name = "TxPromptExpiredError";
  }
}

/**
 * Fixed categories for a wallet error's message (PM 2026-11-02): counted instead of the raw text, which can carry
 * addresses, amounts or signatures. Order matters: the first match wins.
 */
export const WALLET_ERROR_CATEGORIES = ["user-rejected", "simulation-failed", "blockhash", "insufficient-funds", "timeout",
  "unsupported", "disconnected", "network", "empty", "other"] as const;
export type WalletErrorCategory = typeof WALLET_ERROR_CATEGORIES[number];
const CATEGORY_PATTERNS: [Exclude<WalletErrorCategory, "empty" | "other">, RegExp][] = [
  ["user-rejected", /reject|denied|declin|cancel/i],
  ["simulation-failed", /simulat/i],
  ["blockhash", /blockhash|expired|block height/i],
  ["insufficient-funds", /insufficient|not enough|balance/i],
  ["timeout", /time(d)?\s*out|timeout/i],
  ["unsupported", /unsupported|not supported|not implemented/i],
  ["disconnected", /disconnect|not connected|locked/i],
  ["network", /network|fetch|rpc|connection/i],
];
export function walletErrorCategory(error: unknown): WalletErrorCategory {
  const { code, message } = walletErrorInfo(error);
  // A wallet's rejection code wins over an adapter's wrapper text ("WalletSendTransactionError").
  if (code !== undefined && WALLET_REJECTION_CODES.includes(code)) return "user-rejected";
  if (!message) return "empty";
  return CATEGORY_PATTERNS.find(([, pattern]) => pattern.test(message))?.[0] ?? "other";
}

/** The pre-wallet guard stopped before the wallet was asked; the message is the real cause in plain words. */
export class TxPreflightError extends TxNotSentError {
  constructor(message: string) {
    super(message);
    this.name = "TxPreflightError";
  }
}

let cancelSequence = 0;

/**
 * The wallet threw (a cancel, or another wallet error) after we asked it to sign, and Solana had not shown the
 * transaction within the 20 s "checking" window. A wallet can broadcast and still report a cancel (Jupiter Mobile:
 * its own "Sign this message" prompt after the broadcast; Phantom: code 400 "rejected by user"), so this never says
 * "nothing was sent" or "failed": the form unlocks, the same flow + position stays locked, and `landed` keeps
 * checking Solana until the blockhash expires (see `watchCancelledSend`, which turns a late landing into success).
 * `attemptId` keys this attempt's toast, so a resubmit never overwrites it.
 */
export class TxWalletCancelledError extends Error {
  readonly attemptId = `${Date.now().toString(36)}-${++cancelSequence}`;
  readonly walletRejected: boolean;
  constructor(readonly cause: unknown, readonly landed: Promise<LandedOutcome>) {
    const rejected = isWalletRejection(cause);
    super(rejected
      ? "You cancelled in your wallet. We are still checking Solana in case it went through; you can retry in about a minute."
      : `${couldntSendLine(cause)} It has not shown up on Solana; we keep checking in case it went through, and you can retry in about a minute.`);
    this.walletRejected = rejected;
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

/**
 * Only an explicit rejection: code 4001 (EIP-1193 / Phantom), 5000 (WalletConnect USER_REJECTED), or rejection wording
 * on an error with no other code. Never proof that nothing was sent: after a sign request, Solana is checked first.
 */
export const WALLET_REJECTION_CODES: readonly number[] = [4001, 5000];
export function isWalletRejection(error: unknown): boolean {
  const info = walletErrorInfo(error);
  if (info.code !== undefined) return WALLET_REJECTION_CODES.includes(info.code);
  return REJECTED.test(info.message);
}

/** Title of every send failure that is not the user saying no in the wallet (PM 2026-11-03). */
export const COULDNT_SEND_TITLE = "Couldn't send the transaction";

/** URLs (an RPC endpoint can carry an API key in its path or query) and bare host names never reach the screen. */
const URL_RE = /\b(?:https?|wss?):\/\/\S+/gi;
const HOST_RE = /\b[\w-]+(?:\.[\w-]+)*\.(?:com|io|xyz|net|org|dev|app|cloud|network|rpc)(?::\d+)?(?:\/\S*)?/gi;

/** The wallet's own words, stripped of URLs, host names, credentials, request ids and JSON; empty when nothing readable is left. */
export function walletWords(error: unknown): string {
  return scrubCredentialText(walletErrorInfo(error).message)
    .replace(URL_RE, "").replace(HOST_RE, "").replace(/\[redacted[^\]]*\]/gi, "")
    .replace(/\b(request)\s+[0-9a-f-]{8,}\s*/gi, "$1 ").replace(/[{}"[\]]/g, "").replace(/\s+/g, " ").replace(/\s+\)/g, ")").replace(/\(\)/g, "").replace(/\s+/g, " ").trim()
    .replace(/[\s:;,(-]+$/, "").slice(0, 120).replace(/[.\s]+$/, "");
}

/** " (“…”)" with the wallet's own (cleaned) words; empty when there is nothing readable. */
function walletReason(error: unknown) {
  const message = walletWords(error);
  return message ? ` (“${message}”)` : "";
}

const SIGNATURE_FAILURE = /signature ?(verification )?fail|SignatureFailure|invalid signature|missing signature/i;

/**
 * Why a send failed, in plain English, from a fixed list (the wallet's category, see `walletErrorCategory`); only an
 * unrecognised error quotes the wallet's own cleaned words. Never an RPC URL, JSON or a stack frame.
 */
export function sendFailureReason(error: unknown, source: "wallet" | "network" = "wallet"): string {
  const { message } = walletErrorInfo(error);
  if (SIGNATURE_FAILURE.test(message)) return "Solana did not accept the transaction's signature";
  const words = walletWords(error);
  const quoted = source === "network"
    ? (words ? `the network refused it (“${words}”)` : "the network refused it without saying why")
    : (words ? `your wallet said “${words}”` : "your wallet did not say why");
  switch (walletErrorCategory(error)) {
    case "simulation-failed": return "Solana's pre-check says it would fail right now (a price or balance may have changed)";
    case "blockhash": return "it expired before it reached Solana";
    case "insufficient-funds": return "there is not enough SOL or tokens in your wallet to pay for it";
    case "timeout": return source === "network" ? "the network timed out" : "your wallet timed out";
    case "unsupported": return source === "network" ? quoted : "your wallet does not support this request";
    case "disconnected": return source === "network" ? quoted : "your wallet is disconnected or locked";
    case "network": return source === "network" ? "it could not reach the Solana network" : "your wallet could not reach the Solana network";
    // "user-rejected" here is wording only (not an explicit rejection, or it would say cancelled): quote it.
    default: return quoted;
  }
}

/** "Couldn't send the transaction: <reason>." */
export const couldntSendLine = (error: unknown, source: "wallet" | "network" = "wallet") => `${COULDNT_SEND_TITLE}: ${sendFailureReason(error, source)}.`;

/**
 * The toast body under the "Couldn't send the transaction" title: the same text without the repeated prefix,
 * so it starts with the reason. Inline alerts (no title) keep the full line.
 */
export function withoutCouldntSendPrefix(message: string): string {
  const prefix = `${COULDNT_SEND_TITLE}: `;
  if (!message.startsWith(prefix)) return message;
  const rest = message.slice(prefix.length);
  return rest.charAt(0).toUpperCase() + rest.slice(1);
}

/**
 * Whether a failure is a send failure that is not a wallet rejection: these get the "Couldn't send the transaction"
 * title. Only an explicit rejection (`isWalletRejection`) may say "cancelled".
 */
export function isCouldntSend(error: unknown): boolean {
  if (error instanceof TxWalletCancelledError || error instanceof TxNotLandedError) return !error.walletRejected;
  if (error instanceof TxVoidUnconfirmedError) return false;
  return error instanceof TxLandedUnknownError || error instanceof TxRelayRefusedError;
}

export function txFailureKind(error: unknown): TxFailureKind {
  if (error instanceof TxPromptExpiredError) return "expired";
  if (error instanceof TxPreflightError) return "not-sent";
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
  if (error instanceof TxNotLandedError || error instanceof TxLandedUnknownError || error instanceof TxWalletCancelledError ||
    error instanceof TxPromptExpiredError || error instanceof TxPreflightError) return error.message;
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
