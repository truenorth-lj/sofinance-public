"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import Decimal from "decimal.js";
import { ArrowUpRight } from "lucide-react";
import { cn } from "@/lib/cn";
import { APP_ROUTES } from "@/lib/public-urls";
import type { Intent, IntentOutlook, ScenarioOutlook, StrategyKey } from "@/lib/lp-intent";
import { formatAmount, formatCents, formatPct, formatSigned } from "./format";

export type Pace = { scenarioId: string; days: number | null } | null;

const CARD_TONES = ["bg-mint", "bg-lemon", "bg-coral"] as const;
const STRATEGY_LABELS: Record<IntentOutlook["mode"], Record<StrategyKey, string>> = {
  new: { hold: "Enter and hold", rerange: "Enter, re-range if out", exit: "Stay out" },
  existing: { hold: "Hold", rerange: "Re-range if out", exit: "Exit now" },
};

const labelPill =
  "inline-flex h-6 items-center whitespace-nowrap rounded-full border px-2.5 font-data text-[10px] uppercase tracking-[0.14em]";

/** Where a result lands between the loss line (left), zero (centre) and the target (right). */
function GoalMeter({ outcome, target, lossAlert }: { outcome: string | null; target: string; lossAlert: string }) {
  const ticks = 41;
  const centre = (ticks - 1) / 2;
  let marker: number | null = null;
  if (outcome !== null) {
    const value = new Decimal(outcome);
    const share = value.gte(0)
      ? Decimal.min(1, value.div(target)).toNumber()
      : -Decimal.min(1, value.abs().div(lossAlert)).toNumber();
    marker = Math.round(centre + share * centre);
  }
  return (
    <div aria-hidden="true">
      <div className="flex h-9 items-end justify-between">
        {Array.from({ length: ticks }, (_, tick) => {
          const between = marker !== null && tick >= Math.min(centre, marker) && tick <= Math.max(centre, marker);
          return (
            <span
              key={tick}
              className={cn(
                "w-px bg-ink",
                tick === marker ? "h-9 w-[3px] rounded-full" : tick === centre || tick === 0 || tick === ticks - 1 ? "h-5" : "h-3",
                tick === marker || between ? "opacity-90" : "opacity-25",
              )}
            />
          );
        })}
      </div>
      <div className="mt-1.5 flex justify-between font-data text-[10px] tracking-wide text-ink/60">
        <span>{`−${formatAmount(lossAlert)}`}</span>
        <span>0</span>
        <span>{`+${formatAmount(target)}`}</span>
      </div>
    </div>
  );
}

function scenarioStatus(scenario: ScenarioOutlook, intent: Intent): string {
  if (scenario.outcome === null) return "Not enough data to estimate this path.";
  if (scenario.triggersAlert) {
    return `Your alert fires: the position is down ${formatCents(scenario.nets.hold ?? "0")} USDC.`;
  }
  if (scenario.reachesTarget) return intent.goal === "take-profit" ? "Hits your take-profit level." : "Reaches your target.";
  return `${formatCents(scenario.shortfall ?? "0")} USDC short of your target.`;
}

export function ScenarioCards({ intent, outlook }: { intent: Intent; outlook: IntentOutlook | null }) {
  const placeholders = ["Sideways", "Slides out", "Gap down"];
  return (
    <div className="grid gap-3 sm:grid-cols-3 lg:col-span-8">
      {(outlook?.scenarios ?? placeholders).map((entry, index) => {
        const scenario = typeof entry === "string" ? null : entry;
        return (
          <article
            key={scenario?.id ?? entry.toString()}
            style={{ animationDelay: `${160 + index * 70}ms` }}
            className={cn(
              "flex min-h-[19rem] animate-rise flex-col rounded-[28px] p-5 motion-reduce:animate-none",
              scenario ? cn("text-ink", CARD_TONES[index % CARD_TONES.length]) : "border border-white/12 text-cream",
            )}
          >
            <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1.5">
              <span className={cn(labelPill, scenario ? "border-ink/70" : "border-white/30 text-cream/80")}>
                {scenario?.title ?? (entry as string)}
              </span>
              {scenario && (
                <span className="whitespace-nowrap font-data text-[10px] uppercase tracking-[0.14em] text-ink/70">
                  Price {formatPct(scenario.priceChangePct, true)}
                </span>
              )}
            </div>
            {scenario ? (
              <>
                <p className="mt-3 text-[13px] leading-snug text-ink/70">{scenario.blurb}</p>
                <p className="mt-2 font-data text-[10px] uppercase tracking-[0.14em] text-ink/60">
                  {new Decimal(scenario.dailyVolume).isZero()
                    ? "No volume"
                    : `Volume ${formatAmount(scenario.dailyVolume)} USDC a day`}
                </p>
                <div className="mt-auto pt-6">
                  <GoalMeter outcome={scenario.outcome} target={intent.target} lossAlert={intent.lossAlert} />
                  <p className="mt-5 font-data text-[10px] uppercase tracking-[0.14em] text-ink/60">
                    {intent.goal === "beat-holding" ? "USDC vs holding" : "USDC net of costs"}
                  </p>
                  <p className="mt-1 text-[clamp(2.1rem,3.3vw,2.9rem)] font-semibold leading-none tracking-[-0.045em] tabular-nums">
                    {scenario.outcome === null ? "—" : formatSigned(scenario.outcome)}
                  </p>
                  <p className="mt-3 min-h-[3.25rem] border-t border-ink/25 pt-2.5 text-[13px] leading-snug">
                    {scenarioStatus(scenario, intent)}
                  </p>
                </div>
              </>
            ) : (
              <p className="mt-auto text-sm leading-relaxed text-smoke">
                Turn on sample paths to see how this plan lands here.
              </p>
            )}
          </article>
        );
      })}
    </div>
  );
}

function headline(outlook: IntentOutlook): string {
  const total = outlook.scenarios.length;
  if (outlook.reached === total) return `On target in all ${total} sample paths.`;
  if (outlook.reached === 0) return `Out of reach in all ${total} sample paths.`;
  return `On target in ${outlook.reached} of ${total} sample paths.`;
}

function paceLine(intent: Intent, pace: Pace): string {
  if (!pace) return "Not estimated";
  if (pace.days === null) return "Not within a year";
  return pace.days <= intent.days ? `Reached by day ${pace.days}` : `About ${pace.days} days`;
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-t border-white/10 py-3">
      <dt className="shrink-0 font-data text-[10px] uppercase tracking-[0.14em] text-smoke">{label}</dt>
      <dd className="text-right text-sm text-cream">{children}</dd>
    </div>
  );
}

export function RealityCheck({
  intent,
  outlook,
  pace,
  sample,
  onSampleChange,
  onChange,
}: {
  intent: Intent;
  outlook: IntentOutlook | null;
  pace: Pace;
  sample: boolean;
  onSampleChange: (next: boolean) => void;
  onChange: (patch: Partial<Intent>) => void;
}) {
  const base = outlook?.scenarios[0];
  const affordable =
    base?.outcome && new Decimal(base.outcome).gt("0.01") && !base.reachesTarget
      ? new Decimal(base.outcome).toDecimalPlaces(2, Decimal.ROUND_DOWN).toFixed()
      : null;
  return (
    <aside
      aria-label="Reality check"
      style={{ animationDelay: "90ms" }}
      className="flex animate-rise flex-col rounded-[28px] border border-white/12 bg-char p-6 motion-reduce:animate-none sm:p-7 lg:col-span-4 lg:row-span-2"
    >
      <div className="flex items-center justify-between gap-3">
        <span className={cn(labelPill, "border-white/30 text-cream/80")}>Reality check</span>
        <button
          type="button"
          role="switch"
          aria-checked={sample}
          onClick={() => onSampleChange(!sample)}
          className={cn(
            "inline-flex h-7 items-center gap-2 rounded-full border pl-1 pr-3 font-data text-[10px] uppercase tracking-[0.14em] outline-none transition-colors focus-visible:shadow-[0_0_0_2px_var(--color-lemon)]",
            sample ? "border-lemon bg-lemon text-ink" : "border-white/30 text-cream/80 hover:border-white/60",
          )}
        >
          <span className={cn("h-5 w-5 rounded-full transition-colors", sample ? "bg-ink" : "bg-white/25")} />
          Sample paths
        </button>
      </div>

      {!outlook ? (
        <div className="mt-8 flex flex-1 flex-col">
          <h2 className="text-[clamp(1.6rem,2.3vw,2.1rem)] font-medium leading-[1.12] tracking-[-0.03em]">
            No verified forecast for this plan yet.
          </h2>
          <p className="mt-4 text-sm leading-relaxed text-smoke">
            SoFinance holds back a net outcome until prices at the time of each event, costs and fee attribution are
            verified for a pool. Until then you can see how this plan behaves on three sample market paths.
          </p>
          <p className="mt-3 text-sm leading-relaxed text-smoke">
            Sample paths are synthetic. They are not a forecast, carry no probabilities and cannot be traded.
          </p>
          <button
            type="button"
            onClick={() => onSampleChange(true)}
            className="group mt-8 flex h-12 items-center justify-between rounded-full bg-lemon pl-5 pr-1.5 text-sm font-semibold text-ink outline-none transition-transform hover:-translate-y-px focus-visible:shadow-[0_0_0_3px_var(--color-cream)]"
          >
            Preview on sample paths
            <span className="flex h-9 w-9 items-center justify-center rounded-full bg-ink text-lemon transition-transform group-hover:rotate-45">
              <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
            </span>
          </button>
        </div>
      ) : (
        <div className="mt-8 flex flex-1 flex-col" role="status">
          <h2 className="text-[clamp(1.6rem,2.3vw,2.1rem)] font-medium leading-[1.12] tracking-[-0.03em]">
            {headline(outlook)}
          </h2>
          <p className="mt-4 text-sm leading-relaxed text-smoke">
            {`+${formatAmount(intent.target)} USDC is ${formatPct(outlook.targetPct)} on ${formatAmount(intent.amount)} USDC in ${intent.days} ${intent.days === 1 ? "day" : "days"}, a pace of ${formatPct(outlook.targetAnnualizedPct)} a year.`}{" "}
            {intent.goal === "beat-holding"
              ? "Judged against simply holding the starting tokens."
              : "Judged after the costs listed below."}
          </p>

          {(affordable || (pace?.days && pace.days > intent.days)) && (
            <div className="mt-5 flex flex-wrap gap-2">
              {pace?.days && pace.days > intent.days ? (
                <button
                  type="button"
                  onClick={() => onChange({ days: pace.days! })}
                  className="h-8 rounded-full border border-lilac/60 px-3 text-xs font-medium text-lilac outline-none transition-colors hover:bg-lilac hover:text-ink focus-visible:bg-lilac focus-visible:text-ink"
                >
                  Give it {pace.days} days
                </button>
              ) : null}
              {affordable && (
                <button
                  type="button"
                  onClick={() => onChange({ target: affordable })}
                  className="h-8 rounded-full border border-mint/60 px-3 text-xs font-medium text-mint outline-none transition-colors hover:bg-mint hover:text-ink focus-visible:bg-mint focus-visible:text-ink"
                >
                  Aim for +{formatAmount(affordable)} instead
                </button>
              )}
            </div>
          )}

          <dl className="mt-6">
            <Row label="Sideways pace">{paceLine(intent, pace)}</Row>
            <Row label="Loss alert">
              {outlook.alerts === 0
                ? "Stays quiet on every path"
                : `Fires on ${outlook.alerts} of ${outlook.scenarios.length} paths`}
            </Row>
            <Row label="Exit to">
              {intent.exitAsset === "usdc" ? "USDC, plus a small SOL refund" : "The tokens, price exposure stays"}
            </Row>
            <Row label="Sample costs">
              {`${formatAmount(outlook.assumedCosts.hold ?? "0")} to hold · ${formatAmount(outlook.assumedCosts.perRerange ?? "0")} per re-range`}
            </Row>
          </dl>

          <div className="mt-2 border-t border-white/10 pt-4">
            <table className="w-full text-right font-data text-[11px] tabular-nums">
              <caption className="sr-only">Net result in USDC by strategy and sample path</caption>
              <thead>
                <tr className="uppercase tracking-[0.12em] text-smoke">
                  <th scope="col" className="pb-2 text-left font-normal">
                    Net, USDC
                  </th>
                  {outlook.scenarios.map((scenario) => (
                    <th key={scenario.id} scope="col" className="pb-2 pl-2 font-normal">
                      {scenario.short}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(["hold", "rerange", "exit"] as const).map((strategy) => (
                  <tr key={strategy} className="border-t border-white/10">
                    <th scope="row" className="py-2 text-left font-display text-xs font-normal text-cream/85">
                      {STRATEGY_LABELS[outlook.mode][strategy]}
                    </th>
                    {outlook.scenarios.map((scenario) => {
                      const net = scenario.nets[strategy];
                      const best =
                        net !== null &&
                        Object.values(scenario.nets).every((other) => other === null || new Decimal(net).gte(other));
                      return (
                        <td key={scenario.id} className={cn("py-2 pl-2", best ? "text-lemon" : "text-cream/70")}>
                          {net === null ? "—" : formatSigned(net)}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {outlook.assumptions && (
            <div className="mt-7">
              <h3 className="pb-3 font-data text-[10px] font-normal uppercase tracking-[0.14em] text-cream/80">
                Behind the sample paths
              </h3>
              <dl>
                <Row label="Range">
                  {`${formatPct(outlook.assumptions.rangeLowPct, true)} to ${formatPct(outlook.assumptions.rangeHighPct, true)} around entry`}
                </Row>
                <Row label="Fee tier">{formatPct(outlook.assumptions.feePct)}</Row>
                {outlook.assumptions.rerange && (
                  <Row label="Re-range">
                    {`To ${formatPct(outlook.assumptions.rerange.bandLowPct, true)} / ${formatPct(outlook.assumptions.rerange.bandHighPct, true)}, up to ${outlook.assumptions.rerange.maxRebalances} times`}
                  </Row>
                )}
              </dl>
            </div>
          )}

          <div className="mt-auto pt-6">
            <p className="mb-4 text-xs leading-relaxed text-smoke">
              Sample paths are synthetic and carry no probabilities. Read-only: nothing here prepares, signs or sends a
              transaction.
            </p>
            <Link
              href={APP_ROUTES.rwaPairs}
              className="group flex h-12 items-center justify-between rounded-full border border-white/30 pl-5 pr-1.5 text-sm font-medium text-cream outline-none transition-colors hover:border-cream focus-visible:border-lemon"
            >
              Choose a pool for this plan
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
