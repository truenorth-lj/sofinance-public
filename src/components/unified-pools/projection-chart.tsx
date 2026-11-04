"use client";

import { useId, useMemo } from "react";
import Decimal from "decimal.js";
import { breakEvenInPeriod } from "@/lib/lp-plan-chart";
import type { PlanYieldComparison } from "@/lib/lp-plan-yield";
import { formatCents } from "../plan/format";

const W = 1000;
const H = 280;
const DAY_MS = 86_400_000;
const shortDate = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

/** "$1,135" for the axis (whole dollars once the range is wide enough, cents when it is not). */
function axisUsd(value: number, span: number): string {
  return span >= 20 ? `$${formatCents(Math.round(value)).replace(/\.00$/, "")}` : `$${formatCents(value)}`;
}

/**
 * What the position would be worth on each day if you closed it then (after the opening and closing costs), against
 * the same money held. An area under the best case, a faint line for the lowest recent window, the hold level dashed,
 * dates along the bottom from today and values on the right, in the pools page's dark style. SVG for the shapes only
 * (stretched to the box); every label is HTML, so text stays the same size at any width.
 */
export function ProjectionChart({ comparison, low = null, now }: {
  comparison: PlanYieldComparison;
  low?: PlanYieldComparison | null;
  /** Day 0 for the date axis (ms). */
  now: number;
}) {
  const gradientId = useId();
  const chart = useMemo(() => {
    const capital = new Decimal(comparison.capital).toNumber();
    const best = comparison.points.map((point) => capital + new Decimal(point.sofinance).toNumber());
    const lower = low && low.days === comparison.days ? low.points.map((point) => capital + new Decimal(point.sofinance).toNumber()) : null;
    const all = [capital, ...best, ...(lower ?? [])];
    const lo = Math.min(...all);
    const hi = Math.max(...all);
    const pad = Math.max((hi - lo) * 0.12, capital * 0.002);
    const yMin = lo - pad;
    const yMax = hi + pad;
    const days = comparison.days;
    const x = (day: number) => (day / days) * W;
    const y = (value: number) => H - ((value - yMin) / (yMax - yMin)) * H;
    const line = (values: number[]) => values.map((value, day) => `${day === 0 ? "M" : "L"}${x(day).toFixed(1)} ${y(value).toFixed(1)}`).join(" ");
    const bestPath = line(best);
    const ticks = [yMax - pad, (yMax + yMin) / 2, yMin + pad].map((value) => ({ value, top: (y(value) / H) * 100 }));
    const dateTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(days * f));
    const breakEven = breakEvenInPeriod(comparison.breakEvenDay, days);
    return {
      bestPath,
      areaPath: `${bestPath} L${W} ${H} L0 ${H} Z`,
      lowPath: lower ? line(lower) : null,
      holdTop: (y(capital) / H) * 100,
      ticks,
      span: yMax - yMin,
      dateTicks,
      breakEven: breakEven !== null && breakEven > 0 && breakEven < days
        ? { left: (x(breakEven) / W) * 100, top: (y(capital) / H) * 100 }
        : null,
      ahead: best[best.length - 1]! >= capital,
    };
  }, [comparison, low]);
  const stroke = chart.ahead ? "var(--color-mint)" : "var(--color-coral)";

  return <div className="relative pr-16">
    <div className="relative h-56 sm:h-64">
      {/* Dotted grid at the value labels. */}
      {chart.ticks.map((tick) => (
        <div key={tick.value} className="absolute inset-x-0 border-t border-dotted border-white/10" style={{ top: `${tick.top}%` }} />
      ))}
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="absolute inset-0 h-full w-full overflow-visible"
        role="img" aria-label={`Projected value over ${comparison.days} days, from $${formatCents(comparison.capital)} to $${formatCents(comparison.exitValue)}`}>
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={stroke} stopOpacity="0.28" />
            <stop offset="100%" stopColor={stroke} stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={chart.areaPath} fill={`url(#${gradientId})`} />
        {chart.lowPath ? <path d={chart.lowPath} fill="none" stroke={stroke} strokeOpacity="0.35" strokeWidth="1.25" vectorEffect="non-scaling-stroke" /> : null}
        <path d={chart.bestPath} fill="none" stroke={stroke} strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
      </svg>
      {/* HODL: the same money, held. */}
      <div className="absolute inset-x-0 border-t border-dashed border-cream/35" style={{ top: `${chart.holdTop}%` }}>
        <span className="absolute -top-5 left-1 text-[11px] text-smoke">HODL</span>
      </div>
      {chart.breakEven ? <span aria-hidden="true" className="absolute h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full border border-char bg-cream"
        style={{ left: `${chart.breakEven.left}%`, top: `${chart.breakEven.top}%` }} /> : null}
      {/* Values on the right, outside the plot. */}
      {chart.ticks.map((tick) => (
        <span key={tick.value} className="absolute -right-16 w-14 -translate-y-1/2 text-right text-[11px] tabular-nums text-smoke" style={{ top: `${tick.top}%` }}>
          {axisUsd(tick.value, chart.span)}
        </span>
      ))}
    </div>
    <div className="relative mt-2 h-4 text-[11px] tabular-nums text-smoke">
      {chart.dateTicks.map((day, index) => (
        <span key={`${day}-${index}`} className="absolute -translate-x-1/2 whitespace-nowrap first:translate-x-0 last:-translate-x-full"
          style={{ left: `${(day / comparison.days) * 100}%` }}>
          {shortDate.format(new Date(now + day * DAY_MS))}
        </span>
      ))}
    </div>
  </div>;
}
