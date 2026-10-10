"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import Decimal from "decimal.js";
import { DecisionSession } from "@/lib/lp-decision-session";
import type { BoundedMetric } from "@/lib/lp-ledger-analysis";

type Analysis = {
  historical: BoundedMetric;
  hodl: BoundedMetric;
  excess: BoundedMetric;
  knownSubtotal: { lower: string | null; upper: string | null; label: string };
  completeness: Record<string, string | boolean>;
  classification: { policy: string; unknowns: { reason: string }[]; crossTransactionCandidates: unknown[] };
  pricePolicy: string;
  costs?: {
    id: string;
    totalLamports: string | null;
    lowerLamports: string | null;
    upperLamports: string | null;
    allocation: string;
  }[];
  rentRefunds?: { signature: string; refundLamports: string | null }[];
};
type Ledger = {
  source: { kind: string; fresh: boolean; synthetic: boolean; asOf?: string };
  accounting?: Analysis;
  nextCursor: string | null;
  historyReachedEnd: boolean;
  verifiedTransactionCount: number;
  errors?: { detail: string }[];
  error?: string;
};
type Exit = {
  status: string;
  error?: string;
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
};

const number = (value: string) => new Decimal(value).toFixed(4);
const eyebrow = "font-data text-[10px] uppercase tracking-[0.14em] text-smoke";
const pillButton =
  "inline-flex h-10 items-center justify-center rounded-full px-4 text-[13px] font-semibold outline-none transition-colors focus-visible:shadow-[0_0_0_2px_var(--color-cream)] disabled:cursor-not-allowed disabled:opacity-40";

function Bounded({ label, metric }: { label: string; metric: BoundedMetric }) {
  const unavailable = metric.lower === null && metric.upper === null;
  return (
    <div className="border-t border-white/10 py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <p className={eyebrow}>{label}</p>
        <p className="text-sm text-cream">
          {unavailable
            ? "Full value unavailable"
            : `${metric.lower === null ? "lower bound unknown" : number(metric.lower)} to ${metric.upper === null ? "upper bound unknown" : number(metric.upper)} USDC`}
        </p>
      </div>
      <p className="mt-1 text-xs leading-relaxed text-smoke">
        {metric.status} · {metric.missing.length} gaps. A range of reference valuations, not a probability or
        confidence interval.
      </p>
    </div>
  );
}

function Disclosure({ summary, children }: { summary: string; children: ReactNode }) {
  return (
    <details className="border-t border-white/10 py-3">
      <summary className="cursor-pointer text-sm text-cream/90">{summary}</summary>
      <div className="mt-2 space-y-1.5 break-all text-xs leading-relaxed text-smoke">{children}</div>
    </details>
  );
}

export function LpPositionEvidence({ positionId, className = "" }: { positionId: string; className?: string }) {
  const [ledger, setLedger] = useState<Ledger | null>(null);
  const [exit, setExit] = useState<Exit | null>(null);
  const [busy, setBusy] = useState<"ledger" | "exit" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const session = useRef(new DecisionSession());
  const resume = useRef<string | null>(null);

  const cancel = () => {
    session.current.cancel();
    setBusy(null);
    setLedger(null);
    setExit(null);
    setError(null);
    resume.current = null;
  };

  useEffect(() => {
    const value = session.current;
    return () => value.cancel();
  }, [positionId]);

  useEffect(() => {
    if (!exit?.localExpiresAt && !ledger?.source.asOf) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [exit?.localExpiresAt, ledger?.source.asOf]);

  async function run(kind: "ledger" | "exit") {
    const job = session.current.begin();
    if (!job) return;
    setBusy(kind);
    setError(null);
    if (kind === "exit") setExit(null);
    try {
      let before: string | null = kind === "ledger" ? resume.current : null;
      const cursors = new Set<string>();
      for (let page = 0; page < (kind === "ledger" ? 30 : 1); page++) {
        const url =
          kind === "exit"
            ? `/api/lp-decision/exit-preview?positionId=${encodeURIComponent(positionId)}&convertRent=0`
            : `/api/lp-decision/ledger?positionId=${encodeURIComponent(positionId)}&source=live&analyze=1${before ? `&before=${encodeURIComponent(before)}` : ""}`;
        const response = await fetch(url, { signal: job.signal });
        const body = await response.json();
        if (!job.current()) return;
        if (!response.ok) throw new Error(body.error ?? "Public source is unavailable right now");
        if (kind === "exit") {
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
          break;
        }
        if (body.source?.kind !== "live" || body.source?.synthetic !== false || body.source?.fresh !== true) {
          throw new Error("Live ledger refuses demo or replayed sources");
        }
        const data = body as Ledger;
        setLedger(data);
        setNow(Date.now());
        resume.current = data.nextCursor;
        if (data.errors?.length) {
          setError(data.errors.map((e) => e.detail).join("; "));
          break;
        }
        if (data.historyReachedEnd || !data.nextCursor) break;
        if (cursors.has(data.nextCursor)) throw new Error("Source did not advance; kept what was read and stopped");
        cursors.add(data.nextCursor);
        before = data.nextCursor;
      }
    } catch (e) {
      if (job.current()) setError(e instanceof Error ? e.message : "Could not read the source");
    } finally {
      if (job.current()) setBusy(null);
      job.finish();
    }
  }

  const expired = !!exit?.localExpiresAt && now >= Date.parse(exit.localExpiresAt);
  const stale = !!ledger?.source.asOf && now - Date.parse(ledger.source.asOf) > 60000;
  const accounting = ledger?.accounting;

  return (
    <section
      aria-label="Verified ledger and exit preview"
      className={`rounded-[28px] border border-white/12 bg-char p-6 sm:p-7 ${className}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="max-w-xl">
          <span className="inline-flex h-6 items-center whitespace-nowrap rounded-full border border-white/30 px-2.5 font-data text-[10px] uppercase tracking-[0.14em] text-cream/80">
            Verified, read-only
          </span>
          <h2 className="mt-4 text-2xl font-medium tracking-[-0.03em] text-cream">Ledger and exit preview</h2>
          <p className="mt-2 text-sm leading-relaxed text-smoke">
            Reads this position&apos;s public accounts fresh each time. Replays are never shown as current values, and
            the simulation cannot be signed or sent.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={!!busy}
            onClick={() => void run("ledger")}
            className={`${pillButton} border border-white/25 text-cream hover:border-white/70`}
          >
            {busy === "ledger" ? "Reading ledger…" : "Read ledger, history and HODL"}
          </button>
          <button
            type="button"
            disabled={!!busy}
            onClick={() => void run("exit")}
            className={`${pillButton} bg-lemon text-ink hover:bg-[#fff27f]`}
          >
            {busy === "exit" ? "Simulating exit…" : "Preview exit: USDC + SOL"}
          </button>
          <button
            type="button"
            onClick={cancel}
            className="h-10 rounded-full px-3 text-[13px] text-smoke outline-none transition-colors hover:text-cream focus-visible:text-cream"
          >
            Cancel
          </button>
        </div>
      </div>

      {error && (
        <p role="alert" className="mt-5 rounded-2xl border border-lemon/25 bg-lemon/10 px-4 py-3 text-sm text-lemon">
          {error}
        </p>
      )}

      {(ledger || exit) && (
        <div className="mt-6 grid gap-x-10 gap-y-6 lg:grid-cols-2">
          {ledger && (
            <div>
              <p className={eyebrow}>Ledger</p>
              <p className="mt-2 text-sm text-cream">
                {ledger.verifiedTransactionCount} transactions reconciled · history{" "}
                {ledger.historyReachedEnd ? "read to the start" : "has unread windows"}
              </p>
              <p className={`mt-1 text-xs leading-relaxed ${stale ? "text-lemon" : "text-smoke"}`}>
                Valued at {ledger.source.asOf ?? "an unknown time"} ·{" "}
                {stale
                  ? "The position value is over 60 seconds old. Refresh it; the raw history is kept."
                  : "Snapshot from this read"}
              </p>
              {accounting && (
                <div className="mt-4">
                  <p className="pb-3 text-xs leading-relaxed text-smoke">
                    Position accounting {String(accounting.completeness.positionAccounting)} · whole wallet{" "}
                    {String(accounting.completeness.walletAccounting)} (does not block position metrics)
                  </p>
                  <Bounded label="Historical net result" metric={accounting.historical} />
                  <Bounded label="HODL, same cash flows" metric={accounting.hodl} />
                  <Bounded label="Excess over HODL" metric={accounting.excess} />
                  <p className="border-t border-white/10 py-3 text-sm leading-relaxed text-cream/90">
                    {accounting.knownSubtotal.lower !== null && accounting.knownSubtotal.upper !== null
                      ? `Reconciled and priced so far: ${number(accounting.knownSubtotal.lower)} to ${number(accounting.knownSubtotal.upper)} USDC. Not a complete net result.`
                      : "Nothing reconciled could be priced yet. Missing data is not replaced with zero."}
                  </p>
                  <Disclosure summary="Shared costs and refundable rent">
                    {accounting.costs?.map((cost) => (
                      <p key={cost.id}>
                        {cost.id} · paid by the whole transaction {cost.totalLamports ?? "unknown"} lamports · share for
                        this position [{cost.lowerLamports ?? "unknown"}, {cost.upperLamports ?? "unknown"}];{" "}
                        {cost.allocation}. A shared-cost range is not an exact on-chain cost for one LP.
                      </p>
                    ))}
                    {accounting.rentRefunds?.map((refund) => (
                      <p key={refund.signature}>
                        NFT rent refund {refund.refundLamports ?? "not verified"} lamports. An asset recovered, not
                        counted as income.
                      </p>
                    ))}
                  </Disclosure>
                  <Disclosure summary="Attribution and pricing policy">
                    <p>
                      Cross-transaction compounding candidates to verify:{" "}
                      {accounting.classification.crossTransactionCandidates.length}; other unknown attributions:{" "}
                      {accounting.classification.unknowns.length}.
                    </p>
                    <p>{accounting.classification.policy}</p>
                    <p>{accounting.pricePolicy}</p>
                    {accounting.historical.missing.map((reason, index) => (
                      <p key={index}>{reason}</p>
                    ))}
                  </Disclosure>
                </div>
              )}
            </div>
          )}

          {exit && (
            <div aria-label="Split-asset exit result">
              <p className={eyebrow}>Exit preview</p>
              <p className={`mt-2 text-sm font-medium ${expired ? "text-lemon" : "text-cream"}`}>
                {expired
                  ? "Exit preview expired. Read it again."
                  : exit.status === "verified-preview"
                    ? "USDC + SOL exit simulation verified"
                    : "Exit data incomplete or partial"}
              </p>
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
        </div>
      )}
    </section>
  );
}
