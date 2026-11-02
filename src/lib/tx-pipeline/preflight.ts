import type { VersionedTransaction } from "@solana/web3.js";

/**
 * Pre-wallet guard (PM 2026-11-02, after Phantom's one-off "Failed to simulate" on a Meteora add): an adapter opts in
 * with `TxAdapter.preflight`, and `runTx` then
 *   (a) simulates the exact prepared bytes on the server (public RPC, sigVerify off) right before the wallet is asked;
 *       a failure re-prepares (fresh quote, fresh blockhash) once and simulates again; a second failure stops with
 *       the simulation's own cause in plain words;
 *   (d) re-prepares once when the quote is older than `maxQuoteAgeMs` by the time the wallet would be asked;
 *   (b) voids the transaction when the wallet prompt stays unsigned past `promptDeadlineAt` (Try again re-prepares;
 *       nothing is resent automatically);
 *   (c) counts each of these, and wallet rejections, in Sentry with no personal data.
 * Flags are code constants (no env flags). Flows without `preflight` (Raydium, the legacy panels, MCP, /sign) are unchanged.
 */
export type TxPreflightPolicy = {
  /** Quote age (prepare start → wallet prompt) above which the step is prepared again before the wallet is asked. */
  maxQuoteAgeMs: number;
  /** The wallet prompt is voided this long after it opened… */
  maxPromptMs: number;
  /** …or this long after the blockhash was fetched (end of prepare), whichever comes first (blockhash near expiry). */
  blockhashSafeMs: number;
};

/** Defaults for every adapter that opts in. ~150 blocks × 400 ms ≈ 60 s blockhash life; void ~5 s before that. */
export const TX_PREFLIGHT_POLICY: TxPreflightPolicy = { maxQuoteAgeMs: 30_000, maxPromptMs: 60_000, blockhashSafeMs: 55_000 };

export type PreflightSimulation = { ok: true } | { ok: false; cause: string } | { ok: null; unavailable: true };
export type SimulatePrepared = (transaction: VersionedTransaction, permit: { landedPermit?: string; lastValidBlockHeight: number }) => Promise<PreflightSimulation>;

export const PREFLIGHT_SIM_TIMEOUT_MS = 10_000;

const toBase64 = (bytes: Uint8Array) => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

/** `/api/tx-simulate`: a missing permit, a 429 or a network error is "unavailable", never a verdict on the transaction. */
export const simulatePreparedOnServer: SimulatePrepared = async (transaction, { landedPermit, lastValidBlockHeight }) => {
  if (!landedPermit) return { ok: null, unavailable: true };
  try {
    const response = await fetch("/api/tx-simulate", {
      method: "POST", headers: { "Content-Type": "application/json" }, cache: "no-store", signal: AbortSignal.timeout(PREFLIGHT_SIM_TIMEOUT_MS),
      body: JSON.stringify({ unsignedTransaction: toBase64(transaction.serialize()), landedPermit, lastValidBlockHeight }),
    });
    const body = await response.json().catch(() => null) as { ok?: unknown; cause?: unknown } | null;
    if (!response.ok || !body) return { ok: null, unavailable: true };
    if (body.ok === true) return { ok: true };
    if (body.ok === false && typeof body.cause === "string" && body.cause) return { ok: false, cause: body.cause };
    return { ok: null, unavailable: true };
  } catch {
    return { ok: null, unavailable: true };
  }
};
