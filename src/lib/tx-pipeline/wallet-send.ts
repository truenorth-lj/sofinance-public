import bs58 from "bs58";
import { VersionedTransaction } from "@solana/web3.js";
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
 * No client blockhash/TTL gate here: Solana itself rejects an expired transaction, and the
 * confirm stage reports it in plain words.
 *
 * If the wallet throws (or returns no usable signature) after we asked it to sign AND send, it may
 * already have broadcast. We then look the transaction up on-chain (`waitForLanded`) before saying
 * anything: landed → continue as sent; expired and not found → `TxNotLandedError` (safe to retry);
 * undecided → `TxLandedUnknownError` (check Solscan first). A real cancel (EIP-1193 code 4001 exactly; never
 * wording, since Phantom's broadcast-then-throw says "rejected by user" with code 400) is the exception: it throws
 * `TxWalletCancelledError` at once and the same lookup continues in the background (every ~5 s).
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

/** A wallet/connector saying it cannot signAndSend at all (nothing was prompted or signed). */
export function isUnsupportedFeatureError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return /signAndSendTransaction/i.test(message) && /(does not support|not supported|unsupported|not implemented|method not found)/i.test(message);
}

export const RELAY_TIMEOUT_MS = 15_000;

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
} = {}): Promise<{ signature: string; via: "wallet" | "relay"; walletError?: unknown }> {
  const payer = transaction.message.staticAccountKeys[0]?.toBase58();
  if (payer !== wallet.address) throw new TxNotSentError("This transaction was prepared for a different wallet. Nothing was sent.");
  // Pristine prepared copy: the relay's permit covers these bytes; the wallet signs a fresh copy.
  const prepared = clone(transaction);
  if (!options.cosign && wallet.signAndSendTransaction) {
    let signature: string | undefined;
    const askedAt = Date.now();
    try {
      signature = await wallet.signAndSendTransaction(clone(prepared));
    } catch (error) {
      // Some connectors (AppKit, injected wallets) expose signAndSend but the wallet itself lacks
      // the feature; that refusal happens before any prompt, so fall back to sign-then-relay.
      if (!isUnsupportedFeatureError(error)) return checkLanded(error, askedAt);
    }
    if (signature !== undefined) {
      if (!SIGNATURE.test(signature)) return checkLanded(new Error("Your wallet did not return a transaction signature"), askedAt);
      return { signature, via: "wallet" };
    }
  }
  const walletSigned = await wallet.signTransaction(clone(prepared));
  assertWalletReturnedTransaction(prepared, walletSigned, wallet.address);
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
    const lookup = (background: boolean) => {
      const check = { prepared, landedPermit: options.landedPermit, lastValidBlockHeight: options.lastValidBlockHeight,
        preparedAt: askedAt, exclude: options.knownSignatures?.() ?? [] };
      return options.findLanded ? options.findLanded(check, { background }) : waitForLanded(check, { background });
    };
    if (walletErrorInfo(walletError).code === 4001) {
      // Unlock now; keep looking quietly (the caller attaches `watchCancelledSend`). A lookup error is just "unknown".
      const landed = Promise.resolve().then(() => lookup(true)).catch((): LandedOutcome => ({ status: "unknown" }));
      throw new TxWalletCancelledError(walletError, landed);
    }
    options.onChecking?.(walletError);
    const outcome = await lookup(false);
    if (outcome.status === "landed" || outcome.status === "failed") return { signature: outcome.signature, via: "wallet" as const, walletError };
    if (outcome.status === "not-landed") throw new TxNotLandedError(isWalletRejection(walletError), walletError);
    throw new TxLandedUnknownError(walletError);
  }
}
