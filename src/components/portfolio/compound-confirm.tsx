"use client";

import { CircleAlert, LoaderCircle, Sprout } from "lucide-react";
import type { FeeRule } from "@/lib/dex/client";
import { formatUsd } from "@/lib/format/usd";

/** What the Compound popup says before anything runs (LJ 11/14). */
export const COMPOUND_EXPLAINER = "Adds this position's fees back into the same range.";

/** The DEX's compound protocol fee rate from its descriptor: "0.10%", or "Free" where it charges none. */
export function compoundFeeRate(rule: FeeRule | null): string {
  if (!rule) return "—";
  return rule.kind === "none" ? "Free" : `${(rule.bps / 100).toFixed(2)}%`;
}

/**
 * The Compound popup's confirm step: static facts only (the row's unclaimed fees and the descriptor's fee rate; no new
 * simulation). Confirm runs the DEX's existing compound flow, which prepares and then asks the wallet right away.
 */
export function CompoundConfirm({ unclaimedUsd, feeRule, blocked, error, loading, disabled, onConfirm }: {
  unclaimedUsd: number | null | undefined; feeRule: FeeRule | null; blocked: string | null; error?: string | null; loading: boolean; disabled: boolean;
  onConfirm: () => void;
}) {
  return <div data-testid="compound-confirm">
    <p className="mt-2 text-sm leading-6 text-cream/80">{COMPOUND_EXPLAINER}</p>
    <dl className="mt-5 space-y-3 rounded-2xl border border-white/10 p-4 text-sm">
      <div className="flex justify-between gap-4"><dt className="text-smoke">Unclaimed fees</dt>
        <dd data-testid="compound-confirm-unclaimed" className="font-semibold tabular-nums text-cream">{formatUsd(unclaimedUsd ?? null)}</dd></div>
      <div className="flex justify-between gap-4"><dt className="text-smoke">Protocol fee</dt>
        <dd data-testid="compound-confirm-fee" className="font-semibold tabular-nums text-cream">{compoundFeeRate(feeRule)}</dd></div>
    </dl>
    {blocked ? <p role="status" data-testid="compound-confirm-blocked" className="mt-4 text-sm text-smoke">{blocked}</p> : null}
    {error ? <div role="alert" data-testid="compound-confirm-error" className="mt-4 flex gap-2 rounded-2xl border border-white/20 bg-white/[0.04] p-3 text-sm text-cream/80">
      <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" /><span>{error}</span></div> : null}
    <button type="button" data-testid="compound-confirm-button" disabled={disabled} aria-busy={loading} onClick={onConfirm}
      className="mt-5 inline-flex w-full items-center justify-center gap-2 rounded-full bg-lemon px-5 py-3.5 text-sm font-semibold text-ink transition-colors enabled:hover:bg-[#fff27f] disabled:cursor-not-allowed disabled:opacity-40">
      {loading ? <LoaderCircle aria-hidden="true" className="size-4 animate-spin motion-reduce:animate-none" /> : <Sprout aria-hidden="true" className="size-4" />}
      {loading ? "Loading latest fees…" : "Confirm"}
    </button>
  </div>;
}
