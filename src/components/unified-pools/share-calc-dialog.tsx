"use client";

import Link from "next/link";
import { ArrowUpRight, X } from "lucide-react";
import Decimal from "decimal.js";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { parseUsdc } from "@/lib/lp-intent";
import { DEFAULT_PLAN_AMOUNT, DEFAULT_PLAN_DAYS } from "@/lib/lp-plan-intent";
import { aprWindowLabel } from "@/lib/lp-plan-best-apr";
import { planPoolTerms, projectPoolPlan } from "@/lib/lp-plan-pool-terms";
import { lowPlanApr, pairLabelSymbols, planShareSymbol } from "@/lib/lp-plan-shares";
import { dexDescriptors } from "@/lib/dex/client";
import { cn } from "@/lib/cn";
import { HodlVsPool } from "../plan/hodl-vs-pool";
import { formatCents, formatPct, formatSignedPct, formatSignedUsd } from "../plan/format";
import { usePoolYield } from "../plan/use-pool-yield";
import type { OpenAction } from "./pool-list";
import { ProjectionChart } from "./projection-chart";

/** Horizons offered in the dialog, as the chart's range switch. */
export const SHARE_CALC_DAYS = [30, 90, 180, 365] as const;
const rangeLabel = (days: number) => (days === 365 ? "1Y" : `${days}D`);
/** Quick amounts under the input. */
const PRESETS = ["100", "1000", "10000"] as const;
const presetLabel = (value: string) => (value === "100" ? "$100" : `$${Number(value) / 1000}K`);

const panel = "rounded-xl border border-white/10 bg-white/[0.03]";

export type ShareCalcPool = { poolAddress: string; pairLabel: string; protocol: string };

/** A label / value row of the side panel. */
function InfoRow({ label, children }: { label: string; children: ReactNode }) {
  return <div className="flex items-baseline justify-between gap-4 py-1.5">
    <dt className="text-[13px] text-smoke">{label}</dt>
    <dd className="text-right text-[13px] tabular-nums text-cream">{children}</dd>
  </div>;
}

/** Full-width open button for the side panel; it follows the pool card's open action. */
function OpenCta({ action, label }: { action: OpenAction; label: string }) {
  const cls = "flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-lemon text-sm font-semibold text-ink outline-none transition-colors hover:bg-lemon/90 focus-visible:shadow-[0_0_0_3px_var(--color-cream)]";
  const content = <>Open position<ArrowUpRight className="h-4 w-4" aria-hidden="true" /></>;
  if (action.kind === "open") return <button type="button" onClick={action.onOpen} className={cls} aria-label={`Open position in ${label}`}>{content}</button>;
  if (action.kind === "link") return <Link href={action.href} className={cls} aria-label={`Open position in ${label}`}>{content}</Link>;
  return <div>
    <button type="button" disabled aria-disabled="true" aria-label={`Open position in ${label}: ${action.reason}`}
      className={cn(cls, "cursor-not-allowed bg-white/10 text-cream/40 hover:bg-white/10")}>{content}</button>
    <p className="mt-2 text-[12px] text-smoke">{action.reason}</p>
  </div>;
}

/**
 * "Calculate shares" from a pool card: HODL vs HODL + earned shares for this one pool, in a dialog over the pools list.
 * Laid out like a vault page: stat tiles and a projection chart with a range switch on the left, the amount, the open
 * button and the assumptions on the right (stacked on phones, amount first). The only planning surface while
 * `/app/plan` is off (it redirects here): best of the 7 / 30 / 90-day averages, the LP's share of fees, daily
 * compounding, the DEX's opening and closing costs (`projectPoolPlan`); read-only.
 */
export function ShareCalcDialog({ pool, open, onClose }: { pool: ShareCalcPool; open: OpenAction; onClose: () => void }) {
  const [amountText, setAmountText] = useState(DEFAULT_PLAN_AMOUNT);
  const [days, setDays] = useState<number>(DEFAULT_PLAN_DAYS);
  const [now] = useState(() => Date.now());
  const amount = parseUsdc(amountText);
  const closeRef = useRef<HTMLButtonElement>(null);
  const poolYield = usePoolYield(pool.poolAddress);
  const best = poolYield.status === "ready" ? poolYield.best : null;
  const symbols = useMemo(() => pairLabelSymbols(pool.pairLabel), [pool.pairLabel]);
  const shareSymbol = planShareSymbol(symbols);
  const holdLabel = shareSymbol ?? (symbols ? `${symbols.wrappedSymbol} + ${symbols.plainSymbol}` : pool.pairLabel);
  const terms = useMemo(
    () => planPoolTerms({
      descriptor: dexDescriptors.descriptorFor(pool.protocol),
      listOpenReason: null,
      symbols: symbols ? [symbols.wrappedSymbol, symbols.plainSymbol] : undefined,
    }),
    [pool.protocol, symbols],
  );

  // No exit picker here, so the projection takes the conservative one: swapping back to USDC.
  const exit = terms.exits.includes("usdc") ? "usdc" : terms.exits[0] ?? "tokens";
  const projection = useMemo(() => {
    if (!best || !amount) return null;
    const at = (window: { aprPct: string; sampleDays: number; windowDays: number }, horizon: number) =>
      projectPoolPlan({ capital: amount, days: horizon, window, terms, exit });
    const lowWindow = lowPlanApr(best, best.windows);
    return {
      best: at(best, days),
      low: lowWindow ? at(lowWindow, days) : null,
      lowWindow,
      // Difference vs HODL at every horizon of the range switch, like a vault page's 30D / 90D / 1Y returns.
      byHorizon: SHARE_CALC_DAYS.map((horizon) => {
        const plan = at(best, horizon);
        return { days: horizon, pct: new Decimal(plan.vsHold).div(plan.capital).mul(100).toFixed() };
      }),
    };
  }, [best, amount, days, terms, exit]);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape" && !event.defaultPrevented) onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const waiting = !amount
    ? "Enter an amount in USDC to see the projection."
    : poolYield.status === "unavailable"
      ? poolYield.reason
      : "Reading this pool's past fees…";
  // Opening from here closes this dialog first, so the open flow is never stacked under it.
  const openFromHere: OpenAction = open.kind === "open" ? { kind: "open", onOpen: () => { onClose(); open.onOpen(); } } : open;
  const plan = projection?.best ?? null;
  const ahead = plan ? new Decimal(plan.vsHold).gte(0) : true;

  return <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center" data-testid="share-calc-dialog">
    <button type="button" tabIndex={-1} aria-label="Close share calculator" onClick={onClose} className="absolute inset-0 bg-black/70" />
    <section role="dialog" aria-modal="true" aria-label={`${shareSymbol ? "Calculate shares" : "Calculate"} for ${pool.pairLabel}`}
      className="relative max-h-[100dvh] w-full overflow-y-auto rounded-t-2xl border border-white/10 bg-char p-4 text-cream sm:max-w-5xl sm:rounded-2xl sm:p-6">
      <button ref={closeRef} type="button" aria-label="Close" onClick={onClose}
        className="absolute right-3 top-3 z-10 rounded-lg p-2 text-cream/70 outline-none hover:bg-white/5 hover:text-cream focus-visible:shadow-[0_0_0_2px_var(--color-cream)]">
        <X className="size-5" aria-hidden="true" />
      </button>

      <div className="grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        {/* Side panel: amount, open, assumptions. First on phones. */}
        <aside className="flex min-w-0 flex-col gap-3 pt-9 lg:order-2">
          <div className={cn(panel, "bg-white/[0.05] p-4")}>
            <div className="flex items-center justify-between text-[12px] text-smoke">
              <span>You put in</span>
              <span className="tabular-nums">≈ ${amount ? formatCents(amount) : "0.00"}</span>
            </div>
            <div className="mt-2 flex items-center justify-between gap-3">
              <span className="rounded-lg bg-white/[0.06] px-2.5 py-1 text-sm font-semibold">USDC</span>
              <input value={amountText} onChange={(event) => setAmountText(event.target.value)} inputMode="decimal" aria-label="Amount in USDC"
                aria-invalid={!amount}
                className={cn("w-0 min-w-0 flex-1 bg-transparent text-right text-2xl font-medium tabular-nums text-cream outline-none",
                  !amount && "text-coral")} />
            </div>
            <div className="mt-3 flex justify-end gap-1.5">
              {PRESETS.map((value) => (
                <button key={value} type="button" onClick={() => setAmountText(value)}
                  className="rounded-md bg-white/[0.08] px-2 py-0.5 text-[12px] font-medium text-cream/80 outline-none hover:bg-white/15 focus-visible:shadow-[0_0_0_2px_var(--color-lilac)]">
                  {presetLabel(value)}
                </button>
              ))}
            </div>
          </div>

          <div className={cn(panel, "p-4")}>
            <div className="flex items-center justify-between text-[12px] text-smoke">
              <span>After {rangeLabel(days)}, HODL + {shareSymbol ? "earned shares" : "fees"}</span>
            </div>
            <p className={cn("mt-1 text-2xl font-medium tabular-nums", plan ? (ahead ? "text-mint" : "text-coral") : "text-cream/40")}>
              {plan ? `$${formatCents(plan.exitValue)}` : "—"}
            </p>
            <p className="text-[12px] text-smoke">{holdLabel}{shareSymbol ? ` + earned ${shareSymbol}` : ""}</p>
          </div>

          <OpenCta action={openFromHere} label={pool.pairLabel} />

          {plan && projection ? <dl className={cn(panel, "px-4 py-2.5")} data-testid="share-calc-assumptions">
            <InfoRow label={`Est. LP APY (${aprWindowLabel(plan.aprWindowDays)} avg)`}>{formatPct(plan.apyPct)}</InfoRow>
            <InfoRow label="Fees collected">${formatCents(plan.feesEarned)}</InfoRow>
            <InfoRow label="Protocol cut of fees">{`${Math.round((1 - terms.lpFeeShare) * 100)}%`}</InfoRow>
            <InfoRow label="Opening cost">{`−$${formatCents(plan.entryCost)}`}</InfoRow>
            <InfoRow label={exit === "usdc" ? "Closing cost (to USDC)" : "Closing cost"}>{`−$${formatCents(plan.exitCost)}`}</InfoRow>
            {projection.low && projection.lowWindow ? (
              <InfoRow label={`At the ${aprWindowLabel(projection.lowWindow.windowDays)} avg`}>{`${formatSignedUsd(projection.low.vsHold)} vs HODL`}</InfoRow>
            ) : null}
          </dl> : null}
          <p className="px-1 text-[11px] leading-relaxed text-smoke" data-testid="share-calc-footnote">
            {`Best case from the pool's past fees, compounded daily: fees ${terms.lpShareLabel}, ${terms.openCost.rowLabel} to open, ${terms.exitCost[exit].label}. The stock's own price moves both sides alike and is left out. Network fees are ignored. Not a forecast.`}
          </p>
        </aside>

        {/* Main column: tiles, then the chart. */}
        <div className="flex min-w-0 flex-col gap-4 lg:order-1">
          {plan ? <div className="pr-10">
            <HodlVsPool comparison={plan} poolLabel={pool.pairLabel} shareSymbol={shareSymbol} holdLabel={holdLabel} />
          </div> : <p role="status" className="pr-10 pt-2 text-sm text-smoke">{waiting}</p>}

          <div className={cn(panel, "p-4")}>
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 pb-3">
              <span className="border-b-2 border-cream pb-2.5 -mb-[13px] text-sm font-medium">Projected value</span>
              <div role="group" aria-label="Horizon" className="flex gap-1">
                {SHARE_CALC_DAYS.map((option) => (
                  <button key={option} type="button" aria-pressed={days === option} onClick={() => setDays(option)}
                    className={cn("h-7 rounded-md px-2.5 text-[12px] font-semibold outline-none transition-colors focus-visible:shadow-[0_0_0_2px_var(--color-lilac)]",
                      days === option ? "bg-white/15 text-cream" : "text-smoke hover:text-cream")}>
                    {rangeLabel(option)}
                  </button>
                ))}
              </div>
            </div>
            <div className="mt-4 flex flex-wrap items-end justify-between gap-3">
              <p className="text-2xl font-medium tabular-nums">{plan ? `US$${formatCents(plan.exitValue)}` : "—"}</p>
              {projection ? <dl className="flex gap-4 text-right" aria-label="Difference vs HODL by horizon">
                {projection.byHorizon.map((item) => (
                  <div key={item.days}>
                    <dt className="text-[11px] text-smoke">{rangeLabel(item.days)}</dt>
                    <dd className={cn("text-[12px] font-medium tabular-nums", new Decimal(item.pct).gte(0) ? "text-mint" : "text-coral")}>
                      {formatSignedPct(item.pct)}
                    </dd>
                  </div>
                ))}
              </dl> : null}
            </div>
            <div className="mt-4">
              {plan ? <ProjectionChart comparison={plan} low={projection?.low ?? null} now={now} />
                : <div className="h-56 sm:h-64" aria-hidden="true" />}
            </div>
          </div>
        </div>
      </div>
    </section>
  </div>;
}
