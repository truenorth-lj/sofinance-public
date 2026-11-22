import type { ReactNode } from "react";
import Decimal from "decimal.js";
import { breakEvenInPeriod } from "@/lib/lp-plan-chart";
import type { PlanYieldComparison } from "@/lib/lp-plan-yield";
import { cn } from "@/lib/cn";
import { approxUsd, daysWord, formatAmount, formatInUnit, formatSignedInUnit, formatSignedPct, USD_UNIT, type AmountUnit } from "./format";

/** One stat tile: a small sentence-case label, the value, and an optional line under it. */
function Tile({ label, value, sub, approx, tone = "plain", ariaLabel }: {
  label: string; value: ReactNode; sub?: ReactNode; approx?: string | null; tone?: "plain" | "up" | "down"; ariaLabel?: string;
}) {
  return <section aria-label={ariaLabel ?? label} className="rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3.5">
    <p className="text-[12px] text-smoke">{label}</p>
    <p className={cn("mt-1 text-xl font-medium tabular-nums tracking-[-0.01em]",
      tone === "up" ? "text-mint" : tone === "down" ? "text-coral" : "text-cream")}>{value}</p>
    {approx ? <p className="text-[11px] tabular-nums text-smoke/80" data-testid="approx-usd">{approx}</p> : null}
    {sub ? <p className="mt-0.5 text-[12px] tabular-nums text-smoke">{sub}</p> : null}
  </section>;
}

/**
 * The plan as stat tiles for the same amount: what holding is worth, what holding in the pool (earning fees on top) is
 * worth after the opening and closing costs, the difference, and the day the fees have covered those costs. Same numbers
 * as the chart (best recent window, daily compounding); the stock's own price moves both sides alike, so it is left out
 * and holding stays flat.
 */
export function HodlVsPool({
  comparison,
  holdLabel,
  poolLabel,
  shareSymbol = null,
  unit = USD_UNIT,
}: {
  comparison: PlanYieldComparison;
  /** What the hold side holds, e.g. "SPCX" or "USDC + USDT". */
  holdLabel: string;
  /** The pool the other side joins, e.g. "SPCXx/SPCX". */
  poolLabel: string;
  shareSymbol?: string | null;
  /** What amounts are counted in (SP-2: the pool's asset in the pools calculator); dollars by default. */
  unit?: AmountUnit;
}) {
  const capital = new Decimal(comparison.capital);
  const vsHold = new Decimal(comparison.vsHold);
  const tone = vsHold.gte(0) ? "up" : "down";
  const breakEven = breakEvenInPeriod(comparison.breakEvenDay, comparison.days);
  const period = `${comparison.days} ${daysWord(comparison.days)}`;
  // Stock pools grow the share count; the stablecoin pool has no stock, so it just earns fees.
  const earn = shareSymbol ? "more shares" : "fees";

  return <div data-testid="hodl-vs-pool">
    <h2 id="hodl-vs-pool-heading" className="text-lg font-semibold tracking-[-0.01em] text-cream">
      HODL vs. HODL <span className="text-lemon">+ {earn}</span>
    </h2>
    <p className="mt-0.5 text-[13px] text-smoke">
      {shareSymbol ? `Collect more ${shareSymbol} while you hold ${shareSymbol}` : `Collect swap fees while you hold ${holdLabel}`}
      {` · ${unit.kind === "usd" ? `$${formatAmount(capital.toFixed())}` : formatInUnit(capital.toFixed(), unit)} for ${period}`}
    </p>

    <div className="mt-3 grid grid-cols-2 gap-2.5">
      <Tile label="HODL" value={formatInUnit(capital.toFixed(), unit)} approx={approxUsd(capital.toFixed(), unit)}
        sub={`${holdLabel} · ${formatSignedInUnit(0, unit)} (0%)`} />
      <Tile label={`HODL + ${earn}`} value={formatInUnit(comparison.exitValue, unit)} approx={approxUsd(comparison.exitValue, unit)} tone={tone}
        sub={`${poolLabel} · ${formatSignedInUnit(comparison.endSofinance, unit)} (${formatSignedPct(comparison.endGainPct)})`} />
      <Tile label="Difference" value={formatSignedInUnit(vsHold.toFixed(), unit)} tone={tone}
        sub={`${formatSignedPct(vsHold.div(capital).mul(100).toFixed())} vs HODL`} />
      <Tile label="Break-even" value={breakEven === null ? "Not in this period" : `Day ${breakEven}`}
        sub="Fees cover opening and closing" />
    </div>
  </div>;
}
