"use client";

import { Fragment, type ReactNode } from "react";
import Link from "next/link";
import Decimal from "decimal.js";
import { ArrowUpRight } from "lucide-react";
import { cn } from "@/lib/cn";
import { APP_ROUTES, buildOpenPositionPath } from "@/lib/public-urls";
import type { BestPlanApr } from "@/lib/lp-plan-best-apr";
import { breakEvenInPeriod } from "@/lib/lp-plan-chart";
import type { PlanSetup } from "@/lib/lp-plan-intent";
import { isThinPlanSample, type PlanYieldComparison } from "@/lib/lp-plan-yield";
import { LEGACY_PLAN_TERMS, type PlanPoolTerms } from "@/lib/lp-plan-pool-terms";
import { bestAprCopy, completeDaysCopy, daysWord, formatAmount, formatCents, formatCost, formatPct, formatSigned, formatSignedPct } from "./format";
import type { ChartStatus } from "./comparison-chart";

const labelPill =
  "inline-flex h-6 items-center whitespace-nowrap rounded-full border px-2.5 font-data text-[10px] uppercase tracking-[0.14em]";

/**
 * A label/value row. `note` is small print on its own full-width line under both, so it never squeezes the value; such a
 * row may also wrap its value under a long label (right-aligned) instead of running past the card at 375.
 */
function Row({ label, children, note, noteTestId }: { label: string; children: ReactNode; note?: ReactNode; noteTestId?: string }) {
  return (
    <div className={cn("flex items-baseline justify-between gap-x-4 border-t border-white/10 py-3", note && "flex-wrap")}>
      <dt className="shrink-0 font-data text-[10px] uppercase tracking-[0.14em] text-smoke">{label}</dt>
      <dd className="ml-auto min-w-0 text-right text-sm text-cream">{children}</dd>
      {note ? <dd className="mt-1 w-full text-xs leading-relaxed text-smoke" data-testid={noteTestId}>{note}</dd> : null}
    </div>
  );
}

function breakEvenCopy(comparison: PlanYieldComparison): string {
  if (comparison.breakEvenDay === null) return "Not reached in a year";
  const inPeriod = breakEvenInPeriod(comparison.breakEvenDay, comparison.days);
  if (inPeriod === null) return "Not within this period";
  if (inPeriod === 0) return "Day 0";
  return `Day ${inPeriod}`;
}

function headline(comparison: PlanYieldComparison): string {
  if (isThinPlanSample(comparison.sampleDays)) {
    return `Only ${comparison.sampleDays} ${comparison.sampleDays === 1 ? "complete day" : "complete days"} of data — this estimate is unreliable.`;
  }
  return `${formatCents(comparison.exitValue)} USDC`;
}

function summary(setup: PlanSetup, comparison: PlanYieldComparison, terms: PlanPoolTerms): string {
  const gain = `${formatSigned(comparison.endSofinance)} USDC (${formatSignedPct(comparison.endGainPct)})`;
  const horizon = `${setup.days} ${daysWord(setup.days)}`;
  if (isThinPlanSample(comparison.sampleDays)) {
    return `The best past average is ${formatPct(comparison.aprPct)} a year over only ${completeDaysCopy(comparison.sampleDays)}, which would be ${gain} in ${horizon}. That sample is too short to treat as a forecast.`;
  }
  return `Best case after ${horizon}: ${gain} net, once ${terms.openCost.summary}.`;
}

export function OutcomePanel({
  setup,
  status,
  reason,
  comparison,
  best,
  poolId,
  terms = LEGACY_PLAN_TERMS,
}: {
  setup: PlanSetup;
  /** The pool's DEX terms (`planPoolTerms`): opening cost, exit assets, whether it opens from SoFinance. */
  terms?: PlanPoolTerms;
  status: ChartStatus;
  reason?: string;
  comparison: PlanYieldComparison | null;
  best: BestPlanApr | null;
  poolId?: string;
}) {
  return (
    <aside
      aria-label="Best-case outcome"
      style={{ animationDelay: "90ms" }}
      className="flex animate-rise flex-col rounded-[28px] border border-white/12 bg-char p-6 motion-reduce:animate-none sm:p-7 lg:col-span-4 lg:col-start-9 lg:row-start-2"
    >
      <div className="flex items-center justify-between gap-3">
        <span className={cn(labelPill, "border-white/30 text-cream/80")}>Best-case outcome</span>
        <span className="font-data text-[10px] uppercase tracking-[0.14em] text-smoke">Not a forecast</span>
      </div>

      {status !== "ready" || !comparison || !best ? (
        <div className="mt-8 flex flex-1 flex-col">
          <h2 className="text-[clamp(1.6rem,2.3vw,2.1rem)] font-medium leading-[1.12] tracking-[-0.03em]">
            {status === "loading"
              ? "Reading this pool's past yield."
              : status === "unavailable"
                ? "No average yield for this pool."
                : "No pool chosen, so there is no estimate yet."}
          </h2>
          <p className="mt-4 text-sm leading-relaxed text-smoke">
            {reason
              ? reason
              : "SoFinance projects from the best of this pool's 7, 30 and 90-day average yields (complete UTC days only), with daily auto-compounding. That is the optimistic end of recent history, not a forecast, and it carries no probabilities."}
          </p>
          <p className="mt-3 text-sm leading-relaxed text-smoke">
            Two-sided same-asset RWA pairs are compared with a flat hold of the same capital. Network fees
            are ignored.
          </p>
          <Link
            href={APP_ROUTES.rwaPairs}
            className="group mt-8 flex h-12 items-center justify-between rounded-full bg-lemon pl-5 pr-1.5 text-sm font-semibold text-ink outline-none transition-transform hover:-translate-y-px focus-visible:shadow-[0_0_0_3px_var(--color-cream)]"
          >
            Choose a pool for this plan
            <span className="flex h-9 w-9 items-center justify-center rounded-full bg-ink text-lemon transition-transform group-hover:rotate-45">
              <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
            </span>
          </Link>
        </div>
      ) : (
        <div className="mt-8 flex flex-1 flex-col" role="status">
          <p className="font-data text-[10px] uppercase tracking-[0.14em] text-smoke">
            Projected value after {setup.days} {daysWord(setup.days)}
          </p>
          <h2 className="mt-2 text-[clamp(1.6rem,2.3vw,2.1rem)] font-medium leading-[1.12] tracking-[-0.03em]">
            {headline(comparison)}
          </h2>
          <p className="mt-4 text-sm leading-relaxed text-smoke">{summary(setup, comparison, terms)}</p>

          <dl className="mt-6">
            <Row label="Projected final value">{formatCents(comparison.exitValue)} USDC</Row>
            <Row label="Net gain">
              {formatSigned(comparison.endSofinance)} USDC · {formatSignedPct(comparison.endGainPct)}
            </Row>
            <Row label="Opening cost, day 0">
              <span className="block">{`${formatCost(comparison.entryCost)} USDC (${terms.openCost.rowLabel})`}</span>
              {terms.openCost.rowNote && <span className="block text-xs text-smoke" data-testid="plan-open-rent">{terms.openCost.rowNote}</span>}
            </Row>
            <Row label="Closing cost, at exit">
              {`${formatCost(comparison.exitCost)} USDC (${terms.exitCost[setup.exitAsset].label})`}
            </Row>
            <Row
              label="Est. best APY used · not guaranteed"
              note={<>{bestAprCopy(best)}, {formatPct(comparison.aprPct)} to LPs {terms.lpShareLabel}, compounded daily, over {completeDaysCopy(best.sampleDays)}</>}
              noteTestId="plan-apy-note"
            >
              {formatPct(comparison.apyPct)} est. APY
            </Row>
            <Row label="Windows checked">
              {best.windows.map((window, index) => (
                <Fragment key={window.windowDays}>
                  {index > 0 ? " · " : null}
                  <span className="whitespace-nowrap">
                    {window.windowDays}d {formatPct(window.aprPct)}
                  </span>
                </Fragment>
              ))}
            </Row>
            <Row label="Break-even">{breakEvenCopy(comparison)}</Row>
            <Row label="Warn me if down">
              {`−${formatAmount(setup.lossAlert)} USDC (${formatPct(pctOf(setup.lossAlert, setup.amount))})`}
            </Row>
            <Row label="Exit to">
              {setup.exitAsset === "usdc"
                ? "USDC, plus a small SOL refund"
                : terms.tokensExitLabel ? `${terms.tokensExitLabel}; price exposure stays` : "The tokens, price exposure stays"}
            </Row>
          </dl>

          <div className="mt-auto pt-6">
            <p className="mb-4 text-xs leading-relaxed text-smoke">
              {`Best case, not a probability or a promise. "Best APY" is the highest of this pool's 7, 30 and 90-day average fee yields (complete UTC days only), compounded daily with no price-shock path. Break-even is the first day the projection covers ${terms.openCost.breakEven}, plus the closing cost of the exit you chose. Network fees are ignored. Read-only: nothing here prepares, signs or sends a transaction.`}
            </p>
            {poolId && !terms.open.supported ? (
              <div aria-disabled="true" data-testid="plan-open-unavailable" title={terms.open.reason}
                className="flex h-12 cursor-not-allowed items-center justify-between rounded-full border border-white/10 pl-5 pr-1.5 text-sm font-medium text-cream/40">
                <span>Create a position in this pool<span className="sr-only">: {terms.open.reason}</span></span>
                <span className="flex h-9 w-9 items-center justify-center rounded-full bg-white/10 text-cream/40">
                  <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
                </span>
              </div>
            ) : (
              <Link
                href={poolId ? buildOpenPositionPath(poolId) : APP_ROUTES.rwaPairs}
                className="group flex h-12 items-center justify-between rounded-full border border-white/30 pl-5 pr-1.5 text-sm font-medium text-cream outline-none transition-colors hover:border-cream focus-visible:border-lemon"
              >
                {poolId ? "Create a position in this pool" : "Choose a pool for this plan"}
                <span className="flex h-9 w-9 items-center justify-center rounded-full bg-cream text-ink transition-transform group-hover:rotate-45">
                  <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
                </span>
              </Link>
            )}
            {poolId && !terms.open.supported && <p className="mt-2 text-xs text-smoke" data-testid="plan-open-reason">{terms.open.reason}</p>}
          </div>
        </div>
      )}
    </aside>
  );
}

function pctOf(part: string, whole: string): string {
  return new Decimal(part).div(whole).mul(100).toFixed();
}
