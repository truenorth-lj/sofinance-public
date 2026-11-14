"use client";

import { Loader2 } from "lucide-react";
import { useId, useState } from "react";
import { cn } from "@/lib/cn";
import { formatUsd } from "@/lib/format/usd";
import type { PortfolioTotals } from "@/lib/portfolio/figures";

/**
 * "Compound all" (LJ 11/14): shown now, never usable yet. It is greyed out and only says "Coming soon" on hover, focus
 * or tap (phones have no hover). It has no transaction path at all: the click only toggles that note.
 */
export function CompoundAllButton({ className }: { className?: string }) {
  const [shown, setShown] = useState(false);
  const tip = useId();
  return <span className={cn("group relative inline-flex w-fit", className)}>
    <button type="button" aria-disabled="true" aria-describedby={tip} data-testid="compound-all"
      onClick={() => setShown((value) => !value)} onBlur={() => setShown(false)}
      className="cursor-not-allowed rounded-full border border-white/10 bg-white/[0.06] px-3 py-1.5 text-xs font-semibold text-smoke opacity-60">
      Compound all
    </button>
    <span id={tip} role="tooltip" data-testid="compound-all-tip"
      className={cn("pointer-events-none absolute left-[calc(100%+8px)] top-1/2 z-10 -translate-y-1/2 whitespace-nowrap rounded-md bg-cream px-2 py-1 text-[11px] font-semibold text-ink",
        shown ? "block" : "hidden group-hover:block group-focus-within:block")}>Coming soon</span>
  </span>;
}

const count = (n: number) => `${n} ${n === 1 ? "position" : "positions"}`;

/** A total so far (it grows as positions are read; dimmed until all are in), or a dash before the first one. */
function Total({ value, totals }: { value: number | null; totals: PortfolioTotals }) {
  return <p aria-busy={totals.pending > 0} className={cn("mt-1 text-2xl font-semibold tabular-nums tracking-[-0.02em]", totals.pending ? "text-cream/60" : "text-cream")}>{formatUsd(value)}</p>;
}

function Note({ totals }: { totals: PortfolioTotals }) {
  if (totals.pending) return <p role="status" data-testid="portfolio-loading" className="mt-1 flex items-center gap-1.5 text-xs text-smoke">
    <Loader2 className="h-3 w-3 animate-spin motion-reduce:animate-none" aria-hidden="true" />Loading {totals.positions - totals.pending} of {totals.positions} positions…</p>;
  if (totals.missing) return <p className="mt-1 text-xs text-smoke">{count(totals.missing)} could not be read and {totals.missing === 1 ? "is" : "are"} not included.</p>;
  return null;
}

const card = "rounded-2xl border border-white/12 bg-char p-4 sm:p-5";

/**
 * The three numbers at the top of Portfolio (canvas 「精簡後的 Portfolio」): total LP value, cumulative fees (collected +
 * unclaimed) and unclaimed fees, with the greyed "Compound all". Phones get one card: LP value, the two fee totals on one
 * line, then "Compound all".
 */
export function PortfolioSummary({ totals }: { totals: PortfolioTotals }) {
  const fees = (value: number | null) => formatUsd(value);
  return <section aria-label="Portfolio totals" data-testid="portfolio-summary" className="mt-3 grid gap-3 sm:grid-cols-3">
    <div className={card} data-testid="portfolio-total-value">
      <h2 className="text-xs font-semibold text-smoke">Total LP value</h2>
      <Total value={totals.valueUsd} totals={totals} />
      <p className="mt-1 text-xs text-smoke">{count(totals.positions)} · includes unclaimed fees</p>
      <p className="mt-2 text-xs tabular-nums text-smoke sm:hidden">Cumulative fees <span className="text-cream">{fees(totals.cumulativeFeesUsd)}</span> · Unclaimed <span className="text-cream">{fees(totals.unclaimedFeesUsd)}</span></p>
      <CompoundAllButton className="mt-3 sm:hidden" />
      <Note totals={totals} />
    </div>
    <div className={cn(card, "hidden sm:block")} data-testid="portfolio-cumulative-fees">
      <h2 className="text-xs font-semibold text-smoke">Cumulative fees</h2>
      <Total value={totals.cumulativeFeesUsd} totals={totals} />
      <p className="mt-1 text-xs text-smoke">Collected + unclaimed</p>
    </div>
    <div className={cn(card, "hidden border-white/20 sm:block")} data-testid="portfolio-unclaimed-fees">
      <h2 className="text-xs font-semibold text-smoke">Unclaimed fees</h2>
      <Total value={totals.unclaimedFeesUsd} totals={totals} />
      <CompoundAllButton className="mt-3" />
    </div>
  </section>;
}
