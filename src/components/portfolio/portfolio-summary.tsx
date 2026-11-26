"use client";

import { Loader2 } from "lucide-react";
import { useId, useState } from "react";
import { cn } from "@/lib/cn";
import { formatUtcTime } from "@/lib/format/datetime";
import { formatUsd } from "@/lib/format/usd";
import type { PortfolioTotals } from "@/lib/portfolio/figures";
import type { PortfolioPosition } from "@/lib/portfolio/model";

export function PortfolioHistoryStatus({ rows }: { rows: readonly PortfolioPosition[] }) {
  const histories = rows.filter((row) => row.historyStatus);
  if (!histories.length) return null;
  const unavailable = histories.some((row) => row.historyError);
  const updating = histories.some((row) => row.historyStatus === "updating");
  const stale = histories.some((row) => row.historyStatus === "stale" || row.historyStatus === "unavailable");
  const checked = histories.flatMap((row) => row.historyUpdatedAt ? [row.historyUpdatedAt] : []).sort()[0];
  return <p role="status" data-testid="portfolio-history-status" className="mt-2 px-1 text-xs text-smoke">
    {unavailable ? "Cumulative fees are temporarily unavailable. Value and unclaimed fees are current. Refresh to retry. "
      : updating ? "Updating fee history… Available values are shown. "
      : stale ? "Fee history may be out of date. Refresh to retry. " : ""}
    {checked ? <>Fee history checked <time dateTime={checked}>{formatUtcTime(checked, { seconds: true })}</time>.</> : null}
  </p>;
}

/** Compound all's entry point: how many positions it would list, and whether another transaction holds it back. */
type CompoundAllEntry = { count: number; busy: boolean; onOpen: () => void };

/**
 * "Compound all" (LJ 11/26): opens the Compound all popup when at least one position has fees to compound and nothing
 * else is running. Otherwise it stays greyed out and says why on hover, focus or tap (phones have no hover); a click
 * then only toggles that note.
 */
export function CompoundAllButton({ className, entry }: { className?: string; entry?: CompoundAllEntry }) {
  const [shown, setShown] = useState(false);
  const tip = useId();
  if (entry && entry.count > 0 && !entry.busy) {
    return <span className={cn("inline-flex w-fit", className)}>
      <button type="button" data-testid="compound-all" aria-haspopup="dialog" onClick={entry.onOpen}
        className="rounded-full bg-lemon px-3 py-1.5 text-xs font-semibold text-ink transition-colors hover:bg-[#fff27f]">
        Compound all <span className="tabular-nums">({entry.count})</span>
      </button>
    </span>;
  }
  const reason = entry?.busy ? "Another transaction is in progress" : "No unclaimed fees to compound yet";
  return <span className={cn("group relative inline-flex w-fit", className)}>
    <button type="button" aria-disabled="true" aria-describedby={tip} data-testid="compound-all"
      onClick={() => setShown((value) => !value)} onBlur={() => setShown(false)}
      className="cursor-not-allowed rounded-full border border-white/10 bg-white/[0.06] px-3 py-1.5 text-xs font-semibold text-smoke opacity-60">
      Compound all
    </button>
    <span id={tip} role="tooltip" data-testid="compound-all-tip"
      className={cn("pointer-events-none absolute left-[calc(100%+8px)] top-1/2 z-10 -translate-y-1/2 whitespace-nowrap rounded-md bg-cream px-2 py-1 text-[11px] font-semibold text-ink",
        shown ? "block" : "hidden group-hover:block group-focus-within:block")}>{reason}</span>
  </span>;
}

const count = (n: number) => `${n} ${n === 1 ? "position" : "positions"}`;

/** A total so far (it grows as positions are read; dimmed until all are in), or a dash before the first one. */
function Total({ value, totals }: { value: number | null; totals: PortfolioTotals }) {
  return <p aria-busy={totals.pending > 0} className={cn("mt-1 text-2xl font-semibold tabular-nums tracking-[-0.02em]", totals.pending ? "text-cream/60" : "text-cream")}>{formatUsd(value)}</p>;
}

/**
 * Next to the cumulative fees figure only: the Cumulative fees card, or on phones the cumulative line of the one card.
 * Hidden while positions are still loading (the count is not final; the loading hint says so).
 */
function ExcludeNote({ totals, phone = false }: { totals: PortfolioTotals; phone?: boolean }) {
  if (!totals.cumulativePending || totals.pending) return null;
  return <p data-testid={phone ? "portfolio-cumulative-pending-phone" : "portfolio-cumulative-pending"} className={cn("mt-1 text-xs text-smoke", phone && "sm:hidden")}>
    Cumulative fees exclude {count(totals.cumulativePending)}.</p>;
}

function Note({ totals }: { totals: PortfolioTotals }) {
  if (totals.pending) return <p role="status" data-testid="portfolio-loading" className="mt-1 flex items-center gap-1.5 text-xs text-smoke">
    <Loader2 className="h-3 w-3 animate-spin motion-reduce:animate-none" aria-hidden="true" />Loading {totals.positions - totals.pending} of {totals.positions} positions…</p>;
  return <>
    {totals.missing ? <p className="mt-1 text-xs text-smoke">Some values are unavailable for {count(totals.missing)}; totals include available values only.</p> : null}
  </>;
}

const card = "rounded-2xl border border-white/12 bg-char p-4 sm:p-5";

/**
 * The three numbers at the top of Portfolio (canvas 「精簡後的 Portfolio」): total LP value, cumulative fees (collected +
 * unclaimed) and unclaimed fees, with "Compound all". Phones get one card: LP value, the two fee totals on one
 * line, then "Compound all".
 */
export function PortfolioSummary({ totals, cumulativeFeesUpdating = false, cumulativeFeesUnavailable = false, compoundAll }: { totals: PortfolioTotals; cumulativeFeesUpdating?: boolean; cumulativeFeesUnavailable?: boolean; compoundAll?: CompoundAllEntry }) {
  const fees = (value: number | null) => formatUsd(value);
  const updating = cumulativeFeesUnavailable ? <span data-testid="cumulative-fees-unavailable" className="text-smoke"> temporarily unavailable</span>
    : cumulativeFeesUpdating ? <span data-testid="cumulative-fees-updating" className="text-smoke"> Updating</span> : null;
  return <section aria-label="Portfolio totals" data-testid="portfolio-summary" className="mt-3 grid gap-3 sm:grid-cols-3">
    <div className={card} data-testid="portfolio-total-value">
      <h2 className="text-xs font-semibold text-smoke">Total LP value</h2>
      <Total value={totals.valueUsd} totals={totals} />
      <p className="mt-1 text-xs text-smoke">{count(totals.positions)} · includes unclaimed fees</p>
      <p className="mt-2 text-xs tabular-nums text-smoke sm:hidden">Cumulative fees <span className="text-cream">{fees(totals.cumulativeFeesUsd)}</span>{updating} · Unclaimed <span className="text-cream">{fees(totals.unclaimedFeesUsd)}</span></p>
      <ExcludeNote totals={totals} phone />
      <CompoundAllButton className="mt-3 sm:hidden" entry={compoundAll} />
      <Note totals={totals} />
    </div>
    <div className={cn(card, "hidden sm:block")} data-testid="portfolio-cumulative-fees">
      <h2 className="text-xs font-semibold text-smoke">Cumulative fees</h2>
      <Total value={totals.cumulativeFeesUsd} totals={totals} />
      <p className="mt-1 text-xs text-smoke">Collected + unclaimed{updating}</p>
      <ExcludeNote totals={totals} />
    </div>
    <div className={cn(card, "hidden border-white/20 sm:block")} data-testid="portfolio-unclaimed-fees">
      <h2 className="text-xs font-semibold text-smoke">Unclaimed fees</h2>
      <Total value={totals.unclaimedFeesUsd} totals={totals} />
      <CompoundAllButton className="mt-3" entry={compoundAll} />
    </div>
  </section>;
}
