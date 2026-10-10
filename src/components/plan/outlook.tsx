"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import Decimal from "decimal.js";
import { ArrowUpRight } from "lucide-react";
import { cn } from "@/lib/cn";
import { APP_ROUTES, buildOpenPositionPath } from "@/lib/public-urls";
import type { Intent } from "@/lib/lp-intent";
import type { PlanYieldComparison } from "@/lib/lp-plan-yield";
import { PLAN_PROTOCOL_FEE_BPS, PLAN_SWAP_SHARE } from "@/lib/lp-plan-yield";
import { daysWord, formatAmount, formatPct, formatSigned } from "./format";
import type { ChartStatus } from "./comparison-chart";

const labelPill =
  "inline-flex h-6 items-center whitespace-nowrap rounded-full border px-2.5 font-data text-[10px] uppercase tracking-[0.14em]";

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-t border-white/10 py-3">
      <dt className="shrink-0 font-data text-[10px] uppercase tracking-[0.14em] text-smoke">{label}</dt>
      <dd className="text-right text-sm text-cream">{children}</dd>
    </div>
  );
}

function breakEvenCopy(comparison: PlanYieldComparison): string {
  if (comparison.breakEvenDay === null) return "Not reached in a year";
  if (comparison.breakEvenDay === 0) return "Day 0";
  return `Day ${comparison.breakEvenDay} — after the protocol swap fee`;
}

function headline(intent: Intent, comparison: PlanYieldComparison): string {
  const earned = formatSigned(comparison.endSofinance);
  if (comparison.reachesTarget) {
    return `${earned} USDC in ${intent.days} ${daysWord(intent.days)} — on your aim.`;
  }
  return `${earned} USDC estimated in ${intent.days} ${daysWord(intent.days)}.`;
}

function paceCopy(intent: Intent, comparison: PlanYieldComparison): string {
  if (comparison.daysToTarget === null) return "Not within a year on this yield";
  if (comparison.daysToTarget <= intent.days) return `Reached by day ${comparison.daysToTarget}`;
  return `About ${comparison.daysToTarget} days on this yield`;
}

export function RealityCheck({
  intent,
  status,
  reason,
  comparison,
  poolId,
  onChange,
}: {
  intent: Intent;
  status: ChartStatus;
  reason?: string;
  comparison: PlanYieldComparison | null;
  poolId?: string;
  onChange: (patch: Partial<Intent>) => void;
}) {
  const affordable =
    comparison && !comparison.reachesTarget
      ? formatAim(comparison.endSofinance)
      : null;

  return (
    <aside
      aria-label="Reality check"
      style={{ animationDelay: "90ms" }}
      className="flex animate-rise flex-col rounded-[28px] border border-white/12 bg-char p-6 motion-reduce:animate-none sm:p-7 lg:col-span-4 lg:row-span-2"
    >
      <div className="flex items-center justify-between gap-3">
        <span className={cn(labelPill, "border-white/30 text-cream/80")}>Reality check</span>
        <span className="font-data text-[10px] uppercase tracking-[0.14em] text-smoke">
          Best case
        </span>
      </div>

      {status !== "ready" || !comparison ? (
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
              : "SoFinance estimates from the pool's average complete-UTC-day yield, with daily auto-compounding. That is an estimate from the past, not a forecast, and it carries no probabilities."}
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
          <h2 className="text-[clamp(1.6rem,2.3vw,2.1rem)] font-medium leading-[1.12] tracking-[-0.03em]">
            {headline(intent, comparison)}
          </h2>
          <p className="mt-4 text-sm leading-relaxed text-smoke">
            {`+${formatAmount(intent.target)} USDC is ${formatPct(pctOf(intent.target, intent.amount))} on ${formatAmount(intent.amount)} USDC in ${intent.days} ${daysWord(intent.days)}.`}{" "}
            Past average yield is {formatPct(comparison.aprPct)} a year over {comparison.sampleDays}{" "}
            {comparison.sampleDays === 1 ? "complete UTC day" : "complete UTC days"}.
          </p>

          {(affordable || (comparison.daysToTarget && comparison.daysToTarget > intent.days)) && (
            <div className="mt-5 flex flex-wrap gap-2">
              {comparison.daysToTarget && comparison.daysToTarget > intent.days ? (
                <button
                  type="button"
                  onClick={() => onChange({ days: comparison.daysToTarget! })}
                  className="h-8 rounded-full border border-lilac/60 px-3 text-xs font-medium text-lilac outline-none transition-colors hover:bg-lilac hover:text-ink focus-visible:bg-lilac focus-visible:text-ink"
                >
                  Give it {comparison.daysToTarget} days
                </button>
              ) : null}
              {affordable && (
                <button
                  type="button"
                  onClick={() => onChange({ target: affordable })}
                  className="h-8 rounded-full border border-mint/60 px-3 text-xs font-medium text-mint outline-none transition-colors hover:bg-mint hover:text-ink focus-visible:bg-mint focus-visible:text-ink"
                >
                  Aim for {formatSigned(affordable)} instead
                </button>
              )}
            </div>
          )}

          <dl className="mt-6">
            <Row label="Estimated earn">{formatSigned(comparison.endSofinance)} USDC</Row>
            <Row label="Exit vs put in">
              {`${formatAmount(new Decimal(comparison.exitValue).toDecimalPlaces(2).toFixed())} back vs ${formatAmount(intent.amount)} in`}
            </Row>
            <Row label="Break-even">{breakEvenCopy(comparison)}</Row>
            <Row label="Pace to your aim">{paceCopy(intent, comparison)}</Row>
            <Row label="Exit to">
              {intent.exitAsset === "usdc" ? "USDC, plus a small SOL refund" : "The tokens, price exposure stays"}
            </Row>
          </dl>

          <div className="mt-auto pt-6">
            <p className="mb-4 text-xs leading-relaxed text-smoke">
              Estimate from past average yield, not a forecast. Best case only: fee income with daily
              compounding, no price-shock path. Break-even is the first day the estimate covers the
              protocol swap fee ({PLAN_PROTOCOL_FEE_BPS} bps on an assumed{" "}
              {new Decimal(PLAN_SWAP_SHARE).mul(100).toFixed(0)}% of the deposit). Network fees are
              ignored. Read-only: nothing here prepares, signs or sends a transaction.
            </p>
            <Link
              href={poolId ? buildOpenPositionPath(poolId) : APP_ROUTES.rwaPairs}
              className="group flex h-12 items-center justify-between rounded-full border border-white/30 pl-5 pr-1.5 text-sm font-medium text-cream outline-none transition-colors hover:border-cream focus-visible:border-lemon"
            >
              {poolId ? "Create a position in this pool" : "Choose a pool for this plan"}
              <span className="flex h-9 w-9 items-center justify-center rounded-full bg-cream text-ink transition-transform group-hover:rotate-45">
                <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
              </span>
            </Link>
          </div>
        </div>
      )}
    </aside>
  );
}

function pctOf(part: string, whole: string): string {
  return new Decimal(part).div(whole).mul(100).toFixed();
}

function formatAim(value: string): string | null {
  const rounded = new Decimal(value).toDecimalPlaces(2, Decimal.ROUND_DOWN);
  return rounded.gt("0.01") ? rounded.toFixed(2) : null;
}
