import "server-only";

import type { Connection, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";

/** Shared by every one-shot server broadcast: RPC preflight plus node-side rebroadcast, no local resend loop. */
export const BROADCAST_SEND_OPTIONS = {
  skipPreflight: false,
  preflightCommitment: "confirmed",
  maxRetries: 3,
} as const;

export class BroadcastExpiredError extends Error {
  readonly code = "broadcast_expired" as const;
  constructor(message: string) {
    super(message);
    this.name = "BroadcastExpiredError";
  }
}

export class BroadcastSignatureMismatchError extends Error {
  readonly code = "broadcast_signature_mismatch" as const;
  constructor(message: string) {
    super(message);
    this.name = "BroadcastSignatureMismatchError";
  }
}

export function isBroadcastExpiredError(error: unknown): error is BroadcastExpiredError {
  return error instanceof BroadcastExpiredError;
}

export type BroadcastExpiry = {
  lastValidBlockHeight: number;
  /** If set, the transaction is also expired when `Date.now() >= expiresAt`. */
  expiresAt?: number;
};

/**
 * One-shot server broadcast: optional expiry / block-height check, then
 * `sendRawTransaction` with {@link BROADCAST_SEND_OPTIONS}, then signature equality.
 * Fee-wallet guards and simulation stay with the caller. There is no resend loop.
 * Callers that must not mark an expiry as "sent" should set `onBeforeSend` after the
 * check (or rely on {@link BroadcastExpiredError} being thrown before send).
 */
export async function broadcastSignedTransaction(input: {
  connection: Pick<Connection, "sendRawTransaction" | "getBlockHeight">;
  transaction: VersionedTransaction;
  /** Defaults to the first signature on `transaction`. */
  expectedSignature?: string;
  expiry?: BroadcastExpiry;
  expiredMessage?: string;
  mismatchMessage?: string;
  onBeforeSend?: () => void;
}): Promise<string> {
  const expected = input.expectedSignature ?? bs58.encode(input.transaction.signatures[0]!);
  if (input.expiry) {
    const timedOut = input.expiry.expiresAt !== undefined && Date.now() >= input.expiry.expiresAt;
    if (timedOut || await input.connection.getBlockHeight("confirmed") > input.expiry.lastValidBlockHeight) {
      throw new BroadcastExpiredError(input.expiredMessage ?? "Signed transaction expired before broadcast");
    }
  }
  input.onBeforeSend?.();
  const signature = await input.connection.sendRawTransaction(input.transaction.serialize(), BROADCAST_SEND_OPTIONS);
  if (signature !== expected) {
    throw new BroadcastSignatureMismatchError(input.mismatchMessage ?? "RPC returned a different signature");
  }
  return signature;
}
