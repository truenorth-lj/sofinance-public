"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Decimal from "decimal.js";
import { DecisionSession } from "@/lib/lp-decision-session";

type Exit = {
  status: string;
  error?: string;
  errorCode?: string;
  reason?: string;
  recoveryUSDCAtomic?: string;
  recoverySOLLamports?: string;
  networkAndPriorityLamports?: string | null;
  observedAt?: string;
  localExpiresAt?: string;
  remainingTokenDeltas?: string[];
  bytes?: number;
  executable?: boolean;
  sent?: boolean;
  received?: { mint: string; amountAtomic: string }[];
};

function oversizedExit(exit: Exit): boolean {
  return /exceeds 1232 bytes/i.test(exit.reason ?? exit.error ?? "");
}

function jupiterQuoteError(message: string, code?: string): boolean {
  return code === "jupiter_unavailable" || /jupiter swap quotes are temporarily unavailable/i.test(message);
}


/** The client gives up on a stalled estimate well before the server's own 90s budget. */
const EXIT_REQUEST_TIMEOUT_MS = 45_000;
/** Longest the automatic mode waits for the holder's NFT token account before offering a manual preview. */
const ACCOUNT_WAIT_MS = 15_000;

const eyebrow = "font-data text-[10px] uppercase tracking-[0.14em] text-smoke";
const pillButton =
  "inline-flex h-10 items-center justify-center rounded-full px-4 text-[13px] font-semibold outline-none transition-colors focus-visible:shadow-[0_0_0_2px_var(--color-cream)] disabled:cursor-not-allowed disabled:opacity-40";

/**
 * Read-only "USDC + SOL if you exit now" estimate for one position (a server-side unsigned simulation: it can never be
 * signed or sent).
 *
 * - Manual mode (default): the user presses "Preview exit".
 * - `autoExit`: runs by itself once `nftAccount` (the holder's NFT token account, which spares a rate-limited
 *   on-chain lookup) is known. While the parent is still resolving that account (`nftAccountPending`) it says so, for at
 *   most ACCOUNT_WAIT_MS. If the account is not available (no wallet, wallet does not hold this position, state read
 *   failed) it never spins: it explains why and offers the manual preview, which lets the server look the holder up.
 */
export function PositionExitEstimate({ positionId, nftAccount, nftAccountPending = false, autoExit = false, className = "" }: {
  positionId: string;
  nftAccount?: string;
  nftAccountPending?: boolean;
  autoExit?: boolean;
  className?: string;
}) {
  const [exit, setExit] = useState<Exit | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [waitExpired, setWaitExpired] = useState(false);
  const session = useRef(new DecisionSession());
  const exitTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearExitTimeout = () => {
    if (exitTimeout.current) clearTimeout(exitTimeout.current);
  };
  const cancel = () => {
    session.current.cancel();
    clearExitTimeout();
    setBusy(false);
    setExit(null);
    setError(autoExit ? "Exit estimate cancelled. You can retry." : null);
  };

  useEffect(() => {
    const value = session.current;
    return () => {
      value.cancel();
      if (exitTimeout.current) clearTimeout(exitTimeout.current);
    };
  }, [positionId, nftAccount]);

  useEffect(() => {
    if (!exit?.localExpiresAt) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [exit?.localExpiresAt]);

  const waitingForAccount = autoExit && !nftAccount && nftAccountPending;
  useEffect(() => {
    if (!waitingForAccount) return;
    const timer = setTimeout(() => setWaitExpired(true), ACCOUNT_WAIT_MS);
    return () => {
      clearTimeout(timer);
      setWaitExpired(false);
    };
  }, [waitingForAccount]);

  const run = useCallback(async () => {
    const job = session.current.begin();
    if (!job) return;
    setBusy(true);
    setError(null);
    setExit(null);
    exitTimeout.current = setTimeout(() => {
      if (!job.current()) return;
      session.current.cancel();
      setBusy(false);
      setError("Exit estimate timed out. Please retry in a moment.");
    }, EXIT_REQUEST_TIMEOUT_MS);
    try {
      const url = `/api/lp-decision/exit-preview?positionId=${encodeURIComponent(positionId)}&convertRent=0${nftAccount ? `&nftAccount=${encodeURIComponent(nftAccount)}` : ""}`;
      const response = await fetch(url, { signal: job.signal });
      const body = await response.json();
      if (!job.current()) return;
      if (!response.ok) {
        const message = typeof body.error === "string" && body.error ? body.error : "Public source is unavailable right now";
        const failure = new Error(message);
        if (typeof body.errorCode === "string") failure.name = body.errorCode;
        throw failure;
      }
      if (body.sent !== false || body.executable !== false) throw new Error("Read-only exit contract mismatch");
      if (
        body.status === "verified-preview" &&
        (!/^\d+$/.test(body.recoveryUSDCAtomic ?? "") ||
          !/^-?\d+$/.test(body.recoverySOLLamports ?? "") ||
          !Number.isFinite(Date.parse(body.localExpiresAt ?? "")))
      ) {
        throw new Error("Exit amounts or expiry are missing");
      }
      setExit(body);
      setNow(Date.now());
    } catch (e) {
      if (job.current()) setError(e instanceof Error ? e.message : "Could not read the source");
    } finally {
      if (job.current()) {
        clearExitTimeout();
        setBusy(false);
      }
      job.finish();
    }
  }, [positionId, nftAccount]);

  useEffect(() => {
    if (!autoExit || !nftAccount) return;
    const timer = setTimeout(() => {
      setExit(null);
      setError(null);
      setBusy(false);
      void run();
    }, 0);
    return () => clearTimeout(timer);
  }, [autoExit, nftAccount, run]);

  const expired = !!exit?.localExpiresAt && now >= Date.parse(exit.localExpiresAt);
  const waitingText = waitingForAccount && !waitExpired;
  const manualButton = !autoExit || (!nftAccount && !waitingText);
  const showButton = manualButton || (!busy && (error || expired || (exit && exit.status !== "verified-preview")));

  return (
    <section aria-label="Exit estimates" className={`border-t border-white/10 pt-5 ${className}`}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="max-w-xl">
          <h3 className="text-base font-semibold text-cream">Exit estimates</h3>
          <p className="mt-2 text-xs leading-relaxed text-smoke">Estimate USDC and SOL received if you exit now.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {showButton && (
            <button
              type="button"
              disabled={busy || waitingText}
              onClick={() => void run()}
              className={`${pillButton} bg-lemon text-ink hover:bg-[#fff27f]`}
            >
              {busy ? "Simulating exit…" : waitingText ? "Waiting for position accounts…" : manualButton ? "Preview exit: USDC + SOL" : "Recalculate estimate"}
            </button>
          )}
          {busy && (
            <button
              type="button"
              onClick={cancel}
              className="h-10 rounded-full px-3 text-[13px] text-smoke outline-none transition-colors hover:text-cream focus-visible:text-cream"
            >
              Cancel
            </button>
          )}
        </div>
      </div>

      {autoExit && !exit && !error && (
        <p role="status" className="mt-4 flex items-center gap-2 text-sm text-smoke">
          {waitingText || busy || nftAccount ? <span className="h-3 w-3 animate-pulse rounded-full bg-lemon/70" aria-hidden /> : null}
          {waitingText
            ? "Waiting for position accounts…"
            : busy || nftAccount
              ? "Calculating USDC + SOL estimate…"
              : "Automatic estimates need the wallet that holds this position. Connect that wallet, or preview this position manually."}
        </p>
      )}

      {error && (
        <p role="alert" className="mt-5 rounded-2xl border border-lemon/25 bg-lemon/10 px-4 py-3 text-sm text-lemon">
          {jupiterQuoteError(error) ? <span className="block font-semibold">Jupiter quotes unavailable</span> : null}
          {error}
        </p>
      )}

      {exit && (
        <div className="mt-6" aria-label="Split-asset exit result">
          {(expired || exit.status !== "verified-preview") && <p className={`mt-2 text-sm font-medium ${expired || oversizedExit(exit) ? "text-lemon" : "text-cream"}`}>
            {expired
              ? "Exit estimate expired. Run it again."
              : oversizedExit(exit)
                ? `This exit cannot fit in one Solana transaction (${exit.bytes ?? "unknown"} bytes; limit 1232). Withdraw-to-wallet USDC and SOL legs still work as separate vectors.`
                : "Exit data incomplete or partial"}
          </p>}
          {exit.recoveryUSDCAtomic && exit.recoverySOLLamports && (
            <>
              <p className={`mt-4 ${eyebrow}`}>
                {exit.status === "verified-preview"
                  ? "Simulated recovery"
                  : "Partial simulated balance change (assets remain)"}
              </p>
              <p
                className={`mt-1 text-[clamp(1.4rem,2.4vw,2rem)] font-semibold leading-tight tracking-[-0.03em] tabular-nums ${expired ? "text-smoke line-through" : "text-cream"}`}
              >
                {new Decimal(exit.recoveryUSDCAtomic).div(1e6).toFixed(6)} USDC +{" "}
                {new Decimal(exit.recoverySOLLamports).div(1e9).toFixed(9)} SOL
              </p>
              <p className="mt-3 text-xs leading-relaxed text-smoke">
                Network and priority fee {exit.networkAndPriorityLamports ?? "unknown"} lamports, already reflected
                in the SOL change and not deducted again. Swap fees and price impact are already reflected in the
                simulated USDC received.
              </p>
            </>
          )}
          <p className="mt-3 border-t border-white/10 pt-3 text-xs leading-relaxed text-smoke">
            Read {exit.observedAt ?? "at an unknown time"} · valid until {exit.localExpiresAt ?? "unknown"} (local
            conservative refresh window) · {exit.bytes ?? "unknown"} bytes
          </p>
          <p className="mt-2 text-xs leading-relaxed text-smoke">
            SOL keeps its price exposure. This is a split-asset recovery, not all-USDC cash. A read-only simulation
            cannot be signed or sent.
          </p>
          {(exit.error || exit.reason) && <p className="mt-2 text-xs text-lemon">{exit.error || exit.reason}</p>}
        </div>
      )}
    </section>
  );
}
