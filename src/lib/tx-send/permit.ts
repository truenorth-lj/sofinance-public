import "@/lib/engine-host";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { getSigningSecret } from "@sofinance/engine/config/server-env";

/**
 * Send permit for `/api/tx-send`: an HMAC that prepare issues over the exact unsigned
 * transaction bytes it built, bound to the wallet (fee payer). The relay only forwards a
 * wallet-signed transaction whose prepared bytes carry a valid permit, so it cannot be used as
 * an open relay for arbitrary transactions. No expiry: the transaction's own blockhash bounds it.
 */
function payload(wallet: string, prepared: Uint8Array) {
  return `sofinance:tx-send:v1:${wallet}:${createHash("sha256").update(prepared).digest("hex")}`;
}

export function issueTxSendPermit(secret: string, wallet: string, prepared: Uint8Array) {
  if (!secret) throw new Error("Missing server signing key");
  return createHmac("sha256", secret).update(payload(wallet, prepared)).digest("hex");
}

export function verifyTxSendPermit(secret: string, wallet: string, prepared: Uint8Array, permit: unknown) {
  if (!secret || typeof permit !== "string" || !/^[0-9a-f]{64}$/.test(permit)) return false;
  const expected = Buffer.from(issueTxSendPermit(secret, wallet, prepared), "hex");
  return timingSafeEqual(expected, Buffer.from(permit, "hex"));
}

/** Permit for a prepared transaction, given as the base64 `unsignedTransaction` prepare returns. */
export function sendPermitFor(wallet: string, unsignedTransaction: string, secret = getSigningSecret()) {
  return issueTxSendPermit(secret, wallet, Buffer.from(unsignedTransaction, "base64"));
}

/**
 * Check permit for `/api/tx-landed`: a separate HMAC (its own domain) over the same prepared bytes AND the
 * prepare-time `lastValidBlockHeight`, so the lookup window cannot be stretched by a client-chosen height.
 */
function landedPayload(wallet: string, prepared: Uint8Array, lastValidBlockHeight: number) {
  return `sofinance:tx-landed:v1:${wallet}:${createHash("sha256").update(prepared).digest("hex")}:${lastValidBlockHeight}`;
}

export function issueTxLandedPermit(secret: string, wallet: string, prepared: Uint8Array, lastValidBlockHeight: number) {
  if (!secret) throw new Error("Missing server signing key");
  if (!Number.isSafeInteger(lastValidBlockHeight) || lastValidBlockHeight <= 0) throw new Error("Invalid last valid block height");
  return createHmac("sha256", secret).update(landedPayload(wallet, prepared, lastValidBlockHeight)).digest("hex");
}

export function verifyTxLandedPermit(secret: string, wallet: string, prepared: Uint8Array, lastValidBlockHeight: unknown, permit: unknown) {
  if (!secret || typeof permit !== "string" || !/^[0-9a-f]{64}$/.test(permit) ||
    !Number.isSafeInteger(lastValidBlockHeight) || (lastValidBlockHeight as number) <= 0) return false;
  const expected = Buffer.from(issueTxLandedPermit(secret, wallet, prepared, lastValidBlockHeight as number), "hex");
  return timingSafeEqual(expected, Buffer.from(permit, "hex"));
}

/** Both permits for an app prepare response: `sendPermit` (relay) and `landedPermit` (on-chain check after a wallet error). */
export function txPermitsFor(wallet: string, unsignedTransaction: string, lastValidBlockHeight: number | undefined, secret = getSigningSecret()) {
  const bytes = Buffer.from(unsignedTransaction, "base64");
  return {
    sendPermit: issueTxSendPermit(secret, wallet, bytes),
    ...(Number.isSafeInteger(lastValidBlockHeight) && (lastValidBlockHeight as number) > 0
      ? { landedPermit: issueTxLandedPermit(secret, wallet, bytes, lastValidBlockHeight as number) } : {}),
  };
}
