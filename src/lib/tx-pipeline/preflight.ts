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

/**
 * After a voided prompt (PM 2026-11-02, no double-landing): the old transaction could still land until its blockhash
 * expires, so Try again waits for one of
 *   - "landed" / "failed": it reached Solana after all (the wallet's late signature, or the fee payer's history
 *     matched against the prepared transaction): that step is done and is never sent again;
 *   - "expired": the block height (public RPC) is past its `lastValidBlockHeight` and nothing landed: Try again;
 *   - "unknown": we could not tell (no permit and nothing to ask, or the page went away).
 */
export type VoidedOutcome = { status: "landed" | "failed"; signature: string } | { status: "expired" } | { status: "unknown" };
export type WaitVoided = (transaction: VersionedTransaction, check: {
  landedPermit?: string; lastValidBlockHeight: number; preparedAt: number;
  /** The wallet's late signature, once its signAndSend resolves after the void. */
  signature: () => string | undefined;
  /** Seconds left until Try again can be enabled (estimated from the blocks left). */
  onWaiting?: (secondsLeft: number | undefined) => void;
  signal?: AbortSignal;
}) => Promise<VoidedOutcome>;

export const VOIDED_POLL_INTERVAL_MS = 4_000;
/** Stop waiting (answer "unknown") after this; a blockhash expires in ~1 min, so this is only for a stuck RPC. */
export const VOIDED_MAX_WAIT_MS = 5 * 60_000;
const SLOT_MS = 400;

const sleepFor = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve) => {
  const timer = setTimeout(done, ms);
  signal?.addEventListener("abort", done, { once: true });
  function done() { clearTimeout(timer); signal?.removeEventListener("abort", done); resolve(); }
});

export const waitForVoidedExpiry: WaitVoided = async (transaction, check) => {
  // Without a check permit there is nothing to ask: never claim it expired (Try again would risk a double add).
  if (!check.landedPermit) return { status: "unknown" };
  const unsignedTransaction = toBase64(transaction.serialize());
  const startedAt = Date.now();
  let checked: string[] | undefined;
  for (let poll = 0; ; poll++) {
    if (check.signal?.aborted) return { status: "unknown" };
    if (poll > 0) await sleepFor(VOIDED_POLL_INTERVAL_MS, check.signal);
    if (check.signal?.aborted) return { status: "unknown" };
    if (Date.now() - startedAt > VOIDED_MAX_WAIT_MS) return { status: "unknown" };
    const signature = check.signature();
    try {
      const response = await fetch("/api/tx-expiry", {
        method: "POST", headers: { "Content-Type": "application/json" }, cache: "no-store", signal: AbortSignal.timeout(PREFLIGHT_SIM_TIMEOUT_MS),
        body: JSON.stringify({ unsignedTransaction, landedPermit: check.landedPermit, lastValidBlockHeight: check.lastValidBlockHeight,
          preparedAt: check.preparedAt, ...(signature ? { signature } : {}), ...(checked?.length ? { checked } : {}) }),
      });
      if (response.status === 400) return { status: "unknown" };
      const body = await response.json().catch(() => null) as { status?: unknown; signature?: unknown; blocksLeft?: unknown; checked?: unknown } | null;
      if (response.ok && body) {
        if ((body.status === "landed" || body.status === "failed") && typeof body.signature === "string" && body.signature) {
          return { status: body.status, signature: body.signature };
        }
        if (body.status === "expired") return { status: "expired" };
        if (Array.isArray(body.checked)) checked = body.checked.filter((item): item is string => typeof item === "string").slice(-200);
        if (typeof body.blocksLeft === "number") check.onWaiting?.(Math.ceil(body.blocksLeft * SLOT_MS / 1000));
      }
    } catch { /* offline or timed out: keep waiting, never "expired" */ }
  }
};
