import bs58 from "bs58";
import { VersionedTransaction } from "@solana/web3.js";
import { assertWalletReturnedTransaction } from "@/lib/wallet-returned-guard";
import { TxNotSentError, TxSendUnknownError } from "./errors";

/**
 * Stage 2 (send): let the wallet broadcast. Phantom and other Wallet Standard wallets that
 * implement signAndSendTransaction submit through their own RPC and keep rebroadcasting
 * until the blockhash expires, which is what makes other dapps feel smooth. Wallets without
 * it (and flows with a co-signer, like a new position mint that must sign after the wallet)
 * sign first and we submit the raw bytes once. No client blockhash/TTL gate here: Solana
 * itself rejects an expired transaction, and the confirm stage reports it in plain words.
 */
export type TxWallet = {
  address: string;
  signTransaction: (transaction: VersionedTransaction) => Promise<VersionedTransaction>;
  signAndSendTransaction?: (transaction: VersionedTransaction) => Promise<string>;
};

export type SendRaw = (signed: VersionedTransaction) => Promise<string>;

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
export const relaySignedTransaction: SendRaw = async (signed) => {
  const response = await fetch("/api/tx-send", {
    method: "POST", headers: { "Content-Type": "application/json" }, cache: "no-store",
    // A hung relay must not keep the UI in "sending"; a timeout is treated as possibly sent.
    signal: AbortSignal.timeout(RELAY_TIMEOUT_MS),
    body: JSON.stringify({ signedTransaction: toBase64(signed.serialize()) }),
  });
  const body = await response.json().catch(() => ({})) as { signature?: string; error?: string; sent?: boolean };
  if (!response.ok) {
    const error = Object.assign(new Error(body.error || "Transaction submission failed"), { sent: body.sent });
    throw error;
  }
  return String(body.signature ?? "");
};

export async function sendWithWallet(wallet: TxWallet, transaction: VersionedTransaction, options: {
  /** Signers that must sign after the wallet (Phantom requires wallet-first). Forces sign-then-send. */
  cosign?: (walletSigned: VersionedTransaction) => VersionedTransaction;
  sendRaw?: SendRaw;
  /**
   * Relay path only: checked after the wallet signs, before we submit. Lets a flow drop a
   * signature approved after a wallet switch or unmount. (A wallet that sends itself has
   * already broadcast by the time it returns, so there is nothing to stop.)
   */
  stillWanted?: () => boolean;
} = {}): Promise<{ signature: string; via: "wallet" | "relay" }> {
  const payer = transaction.message.staticAccountKeys[0]?.toBase58();
  if (payer !== wallet.address) throw new TxNotSentError("This transaction was prepared for a different wallet. Nothing was sent.");
  if (!options.cosign && wallet.signAndSendTransaction) {
    let signature: string | undefined;
    try {
      signature = await wallet.signAndSendTransaction(transaction);
    } catch (error) {
      // Some connectors (AppKit, injected wallets) expose signAndSend but the wallet itself lacks
      // the feature; that refusal happens before any prompt, so fall back to sign-then-relay.
      if (!isUnsupportedFeatureError(error)) throw error;
    }
    if (signature !== undefined) {
      if (!SIGNATURE.test(signature)) throw new TxNotSentError("Your wallet did not return a transaction signature.");
      return { signature, via: "wallet" };
    }
  }
  const snapshot = VersionedTransaction.deserialize(transaction.serialize());
  const walletSigned = await wallet.signTransaction(transaction);
  assertWalletReturnedTransaction(snapshot, walletSigned, wallet.address);
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
    returned = await (options.sendRaw ?? relaySignedTransaction)(signed);
  } catch (error) {
    // Preflight refusals never reached the network; anything else may have, so track it.
    if ((error as { sent?: unknown } | null)?.sent === false) throw new TxNotSentError(error instanceof Error ? error.message : "Nothing was sent.", error);
    throw new TxSendUnknownError(expected, error);
  }
  if (returned !== expected) throw new TxSendUnknownError(expected, new Error("RPC returned a different signature"));
  return { signature: expected, via: "relay" };
}
