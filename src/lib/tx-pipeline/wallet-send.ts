import bs58 from "bs58";
import { VersionedTransaction } from "@solana/web3.js";
import { WALLET_PRIORITY_FEE_CEILING_LAMPORTS, walletPriorityFeeAllowance } from "@sofinance/engine/wallet-priority-fee";
import { assertWalletReturnedTransaction } from "@/lib/wallet-returned-guard";
import { isWalletRejection, TxLandedUnknownError, TxNotLandedError, TxNotSentError, TxSendUnknownError, TxWalletCancelledError, walletErrorInfo } from "./errors";
import { waitForLanded, type FindLanded, type LandedOutcome } from "./landed";

/**
 * Stage 2 (send): let the wallet broadcast. Phantom and other Wallet Standard wallets that
 * implement signAndSendTransaction submit through their own RPC and keep rebroadcasting
 * until the blockhash expires, which is what makes other dapps feel smooth.
 *
 * Wallets without signAndSend, and flows with a co-signer that must sign after the wallet
 * (a new position's mint keypair), sign first and we submit the raw bytes once through
 * `/api/tx-send`, which only accepts a transaction carrying the prepare-issued `sendPermit`.
 * A step marked `walletSends` (every DEX-route step, LJ 2026-10-31: Phantom flags a transaction it signed that someone
 * else sends) is never relayed: its extra signers `presign` before the wallet, the wallet signs and sends, and a wallet
 * without signAndSend gets `WALLET_MUST_SEND` with nothing sent.
 * No client blockhash/TTL gate here: Solana itself rejects an expired transaction, and the
 * confirm stage reports it in plain words.
 *
 * If the wallet throws (or returns no usable signature) after we asked it to sign AND send, it may
 * already have broadcast. The same holds for a wallet error on the sign-only path when nothing else must co-sign:
 * Jupiter Mobile (WalletConnect, 2026-11-01) broadcast the add, then showed its own "Sign this message to approve
 * your transaction." prompt; cancelling that prompt returned "Request rejected by user" although the add had landed.
 * So a wallet error is never taken as "nothing was sent" or "cancelled" at once, not even an exact 4001:
 * `checkLanded` shows "checking" and looks the transaction up on-chain (`waitForLanded`, server-issued permit) for at
 * most `CHECKING_WINDOW_MS`:
 *   landed (or landed-but-failed) → continue as sent (tracked, success toast, balances refresh);
 *   expired and not found         → `TxNotLandedError` (safe to retry);
 *   still undecided after 20 s    → `TxWalletCancelledError` ("Cancelled — you can retry in about a minute"): the form
 *                                   unlocks, the same flow + position stays locked, and the SAME lookup keeps running
 *                                   in the background until expiry (`watchCancelledSend` turns a late landing into success);
 *   no answer possible (no permit) → cancelled at once for an explicit rejection, otherwise `TxLandedUnknownError`.
 * Nothing in this module (or the pipeline) ever asks the wallet to sign a message.
 */
export type TxWallet = {
  address: string;
  signTransaction: (transaction: VersionedTransaction) => Promise<VersionedTransaction>;
  signAndSendTransaction?: (transaction: VersionedTransaction) => Promise<string>;
};

export type SendRawContext = {
  /** The transaction exactly as prepare returned it (unsigned by the wallet); the permit covers these bytes. */
  prepared: VersionedTransaction;
  sendPermit?: string;
};
export type SendRaw = (signed: VersionedTransaction, context: SendRawContext) => Promise<string>;

const SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;
const toBase64 = (bytes: Uint8Array) => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

/**
 * Wallets add their own priority fee (Phantom inserts a SetComputeUnitPrice when the transaction has none: 97,502
 * lamports on a Meteora setup step, 2026-11-01). It is a network fee the wallet shows and the user approves, but it is
 * not in any prepared quote or SOL check, so on the path where WE relay the signed bytes (non-DEX flows only, see
 * `relaySignedTransaction`) it is held to the same ceiling as the engine's simulations
 * (`WALLET_PRIORITY_FEE_CEILING_LAMPORTS`). A `walletSends` step never reaches it: the wallet sends, so the fee it adds
 * is the wallet's own choice, shown and approved in the wallet, and covered by the 0.01 SOL minimum reserve.
 */
export const WALLET_PRIORITY_FEE_TOO_HIGH = `Your wallet raised the network fee above ${Number(WALLET_PRIORITY_FEE_CEILING_LAMPORTS) / 1e9} SOL, so nothing was sent. Lower the priority fee in your wallet and try again.`;
function assertWalletPriorityFee(prepared: VersionedTransaction, walletSigned: VersionedTransaction) {
  try {
    walletPriorityFeeAllowance(prepared, walletSigned);
  } catch (error) {
    throw new TxNotSentError(WALLET_PRIORITY_FEE_TOO_HIGH, error);
  }
}

export const WALLET_MUST_SEND = "Your wallet can't send this transaction itself, so nothing was sent. Connect a wallet that sends transactions directly, such as Phantom, and try again.";

/** A wallet/connector saying it cannot signAndSend at all (nothing was prompted or signed). */
export function isUnsupportedFeatureError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return /signAndSendTransaction/i.test(message) && /(does not support|not supported|unsupported|not implemented|method not found)/i.test(message);
}

export const RELAY_TIMEOUT_MS = 15_000;
/** The longest "Checking Solana…" holds the form after a wallet error before it switches to the cancelled state. */
export const CHECKING_WINDOW_MS = 20_000;

/**
 * A sign-only wallet error worth an on-chain check: a wallet's own answer (a numeric code, or cancel wording), not a
 * local refusal before any prompt ("does not support", not connected), which never reached the wallet.
 */
function maySignOnlyHaveBroadcast(error: unknown) {
  if (isUnsupportedFeatureError(error)) return false;
  const message = error instanceof Error ? error.message : "";
  if (/(does not support|not supported|unsupported|not connected|method not found|MethodNotSupported)/i.test(message)) return false;
  return walletErrorInfo(error).code !== undefined || isWalletRejection(error);
}

/** Plain sendRawTransaction through our RPC (`/api/tx-send`). One shot: no resend loop. */
export const relaySignedTransaction: SendRaw = async (signed, { prepared, sendPermit }) => {
  const response = await fetch("/api/tx-send", {
    method: "POST", headers: { "Content-Type": "application/json" }, cache: "no-store",
    // A hung relay must not keep the UI in "sending"; a timeout is treated as possibly sent.
    signal: AbortSignal.timeout(RELAY_TIMEOUT_MS),
    body: JSON.stringify({ signedTransaction: toBase64(signed.serialize()), unsignedTransaction: toBase64(prepared.serialize()), sendPermit }),
  });
  const body = await response.json().catch(() => ({})) as { signature?: string; error?: string; sent?: boolean };
  if (!response.ok) {
    const error = Object.assign(new Error(body.error || "Transaction submission failed"), { sent: body.sent });
    throw error;
  }
  return String(body.signature ?? "");
};

const clone = (transaction: VersionedTransaction) => VersionedTransaction.deserialize(transaction.serialize());

export async function sendWithWallet(wallet: TxWallet, transaction: VersionedTransaction, options: {
  /** Signers that must sign after the wallet (Phantom requires wallet-first). Forces sign-then-send. */
  cosign?: (walletSigned: VersionedTransaction) => VersionedTransaction;
  /** Signers that sign before the wallet; the wallet then signs and sends (implies `walletSends`). */
  presign?: (unsigned: VersionedTransaction) => VersionedTransaction;
  /** Only the wallet may send: never sign-then-relay. */
  walletSends?: boolean;
  /** Prepare-issued permit for our relay (`/api/tx-send` refuses transactions without one). */
  sendPermit?: string;
  sendRaw?: SendRaw;
  /**
   * Relay path only: checked after the wallet signs, before we submit. Lets a flow drop a
   * signature approved after a wallet switch or unmount. (A wallet that sends itself has
   * already broadcast by the time it returns, so there is nothing to stop.)
   */
  stillWanted?: () => boolean;
  /** The prepared blockhash's last valid block height: the landed lookup waits for it to pass before "nothing was sent". */
  lastValidBlockHeight?: number;
  /** Prepare-issued check permit for `/api/tx-landed` (signs `lastValidBlockHeight`); absent → the lookup answers "unknown". */
  landedPermit?: string;
  /** Signatures already saved for this wallet: skipped by the landed lookup. */
  knownSignatures?: () => readonly string[];
  /** Called when the wallet threw after a sign-and-send request and the on-chain lookup starts. */
  onChecking?: (walletError: unknown) => void;
  /** Test hook; defaults to polling `/api/tx-landed`. */
  findLanded?: FindLanded;
  /** Test hook; defaults to `CHECKING_WINDOW_MS`. */
  checkingWindowMs?: number;
} = {}): Promise<{ signature: string; via: "wallet" | "relay"; walletError?: unknown }> {
  const payer = transaction.message.staticAccountKeys[0]?.toBase58();
  if (payer !== wallet.address) throw new TxNotSentError("This transaction was prepared for a different wallet. Nothing was sent.");
  // Pristine prepared copy: the relay's permit covers these bytes; the wallet signs a fresh copy.
  const prepared = clone(transaction);
  const walletMustSend = options.walletSends || !!options.presign;
  if (walletMustSend && options.cosign) throw new TxNotSentError("This step needs a signature after the wallet's, which only a relay allows. Nothing was sent.");
  if (walletMustSend && !wallet.signAndSendTransaction) throw new TxNotSentError(WALLET_MUST_SEND);
  if (!options.cosign && wallet.signAndSendTransaction) {
    let signature: string | undefined;
    let outgoing = clone(prepared);
    if (options.presign) {
      try {
        outgoing = options.presign(outgoing);
      } catch (error) {
        throw new TxNotSentError("A required signature could not be added, so nothing was sent.", error);
      }
    }
    const askedAt = Date.now();
    try {
      signature = await wallet.signAndSendTransaction(outgoing);
    } catch (error) {
      // Some connectors (AppKit, injected wallets) expose signAndSend but the wallet itself lacks
      // the feature; that refusal happens before any prompt, so fall back to sign-then-relay
      // (or, when only the wallet may send, stop: nothing was sent).
      if (!isUnsupportedFeatureError(error)) return checkLanded(error, askedAt);
      if (walletMustSend) throw new TxNotSentError(WALLET_MUST_SEND, error);
    }
    if (signature !== undefined) {
      if (!SIGNATURE.test(signature)) return checkLanded(new Error("Your wallet did not return a transaction signature"), askedAt);
      return { signature, via: "wallet" };
    }
  }
  let walletSigned: VersionedTransaction;
  const signAskedAt = Date.now();
  try {
    walletSigned = await wallet.signTransaction(clone(prepared));
  } catch (error) {
    // A co-signed transaction cannot land without our co-signature, and without a check permit there is nothing to ask.
    if (options.cosign || !options.landedPermit || !maySignOnlyHaveBroadcast(error)) throw error;
    return checkLanded(error, signAskedAt);
  }
  assertWalletReturnedTransaction(prepared, walletSigned, wallet.address);
  assertWalletPriorityFee(prepared, walletSigned);
  const signed = options.cosign ? options.cosign(walletSigned) : walletSigned;
  if (signed.signatures.some((signature) => !signature || signature.every((byte) => byte === 0))) {
    throw new TxNotSentError("A required signature is missing, so nothing was sent.");
  }
  if (options.stillWanted && !options.stillWanted()) {
    throw new TxNotSentError("Your wallet or selection changed while signing, so nothing was sent.");
  }
  const expected = bs58.encode(signed.signatures[0]!);
  let returned: string;
  try {
    returned = await (options.sendRaw ?? relaySignedTransaction)(signed, { prepared, sendPermit: options.sendPermit });
  } catch (error) {
    // Preflight refusals never reached the network; anything else may have, so track it.
    if ((error as { sent?: unknown } | null)?.sent === false) throw new TxNotSentError(error instanceof Error ? error.message : "Nothing was sent.", error);
    throw new TxSendUnknownError(expected, error);
  }
  if (returned !== expected) throw new TxSendUnknownError(expected, new Error("RPC returned a different signature"));
  return { signature: expected, via: "relay" };

  async function checkLanded(walletError: unknown, askedAt: number) {
    const check = { prepared, landedPermit: options.landedPermit, lastValidBlockHeight: options.lastValidBlockHeight,
      preparedAt: askedAt, exclude: options.knownSignatures?.() ?? [] };
    const rejected = isWalletRejection(walletError);
    // No permit: nothing to ask, so no "checking" either (e.g. the agent sign page).
    if (!check.landedPermit || !Number.isSafeInteger(check.lastValidBlockHeight) || !check.lastValidBlockHeight) {
      if (rejected) throw new TxWalletCancelledError(walletError, Promise.resolve({ status: "unknown" }));
      throw new TxLandedUnknownError(walletError);
    }
    options.onChecking?.(walletError);
    // One lookup for the whole blockhash lifetime: the first 20 s in front of the user, the rest in the background.
    const lookup: Promise<LandedOutcome> = Promise.resolve()
      .then(() => options.findLanded ? options.findLanded(check, { background: false }) : waitForLanded(check, { background: false }))
      .catch((): LandedOutcome => ({ status: "unknown" }));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const windowEnded = new Promise<"window-ended">((resolve) => { timer = setTimeout(() => resolve("window-ended"), options.checkingWindowMs ?? CHECKING_WINDOW_MS); });
    const first = await Promise.race([lookup, windowEnded]);
    clearTimeout(timer);
    if (first === "window-ended") throw new TxWalletCancelledError(walletError, lookup);
    if (first.status === "landed" || first.status === "failed") return { signature: first.signature, via: "wallet" as const, walletError };
    if (first.status === "not-landed") throw new TxNotLandedError(rejected, walletError);
    if (rejected) throw new TxWalletCancelledError(walletError, Promise.resolve(first));
    throw new TxLandedUnknownError(walletError);
  }
}
