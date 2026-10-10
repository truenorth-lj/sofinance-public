"use client";

import { useMemo } from "react";
import Decimal from "decimal.js";
import type { Intent } from "@/lib/lp-intent";
import type { PlanYieldComparison } from "@/lib/lp-plan-yield";
import { formatAmount, formatPct, formatSigned } from "./format";

const labelPill =
  "inline-flex h-6 items-center whitespace-nowrap rounded-full border border-ink/70 px-2.5 font-data text-[10px] font-normal uppercase tracking-[0.14em]";

export type ChartStatus = "idle" | "loading" | "ready" | "unavailable";

const WIDTH = 720;
const HEIGHT = 280;
const PAD = { l: 48, r: 16, t: 20, b: 36 };

function ticksForDays(days: number): number[] {
  if (days <= 1) return [0, days];
  if (days <= 10) return Array.from({ length: days + 1 }, (_, i) => i);
  const step = days <= 45 ? 5 : days <= 120 ? 15 : days <= 240 ? 30 : 60;
  const ticks = [0];
  for (let day = step; day < days; day += step) ticks.push(day);
  if (ticks[ticks.length - 1] !== days) ticks.push(days);
  return ticks;
}

export function ComparisonChart({
  status,
  reason,
  comparison,
  intent,
}: {
  status: ChartStatus;
  reason?: string;
  comparison: PlanYieldComparison | null;
  intent: Intent;
}) {
  return (
    <section
      aria-label="SoFinance versus hold"
      style={{ animationDelay: "160ms" }}
      className="flex min-h-[19rem] animate-rise flex-col rounded-[28px] bg-cream p-5 text-ink motion-reduce:animate-none sm:p-6 lg:col-span-8"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className={labelPill}>SoFinance vs hold</h2>
        <p className="font-data text-[10px] uppercase tracking-[0.14em] text-ink/60">
          Estimate from past average yield, not a forecast
        </p>
      </div>
      {status === "ready" && comparison ? (
        <ReadyChart comparison={comparison} intent={intent} />
      ) : (
        <p className="mt-auto max-w-xl pt-8 text-sm leading-relaxed text-ink/65">
          {status === "loading"
            ? "Reading this pool's complete UTC-day yield. The chart will update here — nothing is invented while that loads."
            : reason
              ? reason
              : status === "unavailable"
                ? "Past average yield is unavailable for this pool."
                : "Choose a pool to estimate SoFinance against simply holding the same capital. Until a pool is chosen, there is no yield to plot."}
        </p>
      )}
    </section>
  );
}

function ReadyChart({ comparison, intent }: { comparison: PlanYieldComparison; intent: Intent }) {
  const chart = useMemo(() => layoutChart(comparison, intent), [comparison, intent]);
  const vsHold = formatSigned(comparison.vsHold);
  const endLabel = formatSigned(comparison.endSofinance);

  return (
    <div className="mt-5 flex flex-1 flex-col">
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="h-auto w-full"
        role="img"
        aria-label={`SoFinance estimated ${endLabel} USDC versus hold after ${comparison.days} days`}
      >
        <line
          x1={PAD.l}
          y1={PAD.t}
          x2={PAD.l}
          y2={HEIGHT - PAD.b}
          stroke="#0d0d0c"
          strokeOpacity="0.28"
        />
        <line
          x1={PAD.l}
          y1={HEIGHT - PAD.b}
          x2={WIDTH - PAD.r}
          y2={HEIGHT - PAD.b}
          stroke="#0d0d0c"
          strokeOpacity="0.28"
        />
        {chart.yTicks.map((value) => (
          <g key={value}>
            <line
              x1={PAD.l}
              y1={chart.yAt(value)}
              x2={WIDTH - PAD.r}
              y2={chart.yAt(value)}
              stroke="#0d0d0c"
              strokeOpacity="0.08"
            />
            <text
              x={PAD.l - 8}
              y={chart.yAt(value) + 3}
              textAnchor="end"
              fill="#98948b"
              fontSize="10"
              fontFamily="ui-monospace, SFMono-Regular, monospace"
            >
              {formatAxisUsdc(value)}
            </text>
          </g>
        ))}
        {chart.xTicks.map((day) => (
          <text
            key={day}
            x={chart.xAt(day)}
            y={HEIGHT - 10}
            textAnchor="middle"
            fill="#98948b"
            fontSize="10"
            fontFamily="ui-monospace, SFMono-Regular, monospace"
          >
            {day === comparison.days ? `${day}d` : String(day)}
          </text>
        ))}
        <line
          x1={PAD.l}
          y1={chart.yAt(chart.target)}
          x2={WIDTH - PAD.r}
          y2={chart.yAt(chart.target)}
          stroke="#f3e76b"
          strokeWidth="1.5"
          strokeDasharray="5 4"
        />
        <text
          x={PAD.l + 8}
          y={chart.yAt(chart.target) - 6}
          fill="#0d0d0c"
          fillOpacity="0.55"
          fontSize="10"
          fontFamily="ui-monospace, SFMono-Regular, monospace"
        >
          {`aim ${formatSigned(intent.target)}`}
        </text>
        <line
          x1={PAD.l}
          y1={chart.yAt(0)}
          x2={WIDTH - PAD.r}
          y2={chart.yAt(0)}
          stroke="#98948b"
          strokeWidth="1.5"
          strokeDasharray="4 4"
        />
        <path d={chart.sofinancePath} fill="none" stroke="#0d0d0c" strokeWidth="2.25" strokeLinejoin="round" strokeLinecap="round" />
        {chart.breakEven !== null && chart.breakEven > 0 && chart.breakEven <= comparison.days && (
          <g>
            <line
              x1={chart.xAt(chart.breakEven)}
              y1={PAD.t}
              x2={chart.xAt(chart.breakEven)}
              y2={HEIGHT - PAD.b}
              stroke="#ff9c85"
              strokeWidth="1.25"
              strokeDasharray="3 3"
            />
            <text
              x={Math.min(chart.xAt(chart.breakEven) + 4, WIDTH - PAD.r - 4)}
              y={PAD.t + 12}
              fill="#0d0d0c"
              fontSize="10"
              fontFamily="ui-monospace, SFMono-Regular, monospace"
            >
              {`Break-even · day ${chart.breakEven}`}
            </text>
          </g>
        )}
        <circle cx={chart.xAt(comparison.days)} cy={chart.yAt(chart.end)} r="4.5" fill="#84e9c5" stroke="#0d0d0c" strokeWidth="1.5" />
        <text
          x={chart.xAt(comparison.days) - 8}
          y={chart.yAt(chart.end) - 10}
          textAnchor="end"
          fill="#0d0d0c"
          fontSize="11"
          fontFamily="ui-monospace, SFMono-Regular, monospace"
        >
          {endLabel}
        </text>
      </svg>

      <div className="mt-4 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
        <p className="font-data text-[11px] uppercase tracking-[0.14em] text-ink">
          {vsHold} USDC vs hold
        </p>
        <p className="font-data text-[10px] uppercase tracking-[0.14em] text-ink/60">
          End {endLabel} · {comparison.days} {comparison.days === 1 ? "day" : "days"}
          {comparison.breakEvenDay === null
            ? ""
            : ` · break-even day ${comparison.breakEvenDay}`}
        </p>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 font-data text-[10px] uppercase tracking-[0.14em] text-ink/60">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-px w-5 bg-ink" />
          SoFinance
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-px w-5 border-t border-dashed border-smoke" />
          Hold
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-px w-5 border-t border-dashed border-lemon" />
          Your aim
        </span>
        <span>
          Past average {formatPct(comparison.aprPct)} a year · {comparison.sampleDays}{" "}
          {comparison.sampleDays === 1 ? "complete UTC day" : "complete UTC days"}
        </span>
      </div>
      <p className="mt-3 text-[13px] leading-snug text-ink/65">
        Best case from fee income only, with daily auto-compounding and a flat hold for a two-sided same-asset
        pair. Network fees are ignored. This is not a probability and not a promise.
      </p>
    </div>
  );
}

function layoutChart(comparison: PlanYieldComparison, intent: Intent) {
  const end = new Decimal(comparison.endSofinance).toNumber();
  const target = new Decimal(intent.target).toNumber();
  const sofinance = comparison.points.map((point) => new Decimal(point.sofinance).toNumber());
  const lo = Math.min(0, ...sofinance);
  const hi = Math.max(0.01, target, ...sofinance);
  const pad = Math.max((hi - lo) * 0.12, 0.25);
  const yMin = lo - (lo < 0 ? pad : 0);
  const yMax = hi + pad;
  const innerW = WIDTH - PAD.l - PAD.r;
  const innerH = HEIGHT - PAD.t - PAD.b;
  const xAt = (day: number) => PAD.l + (comparison.days <= 0 ? 0 : (day / comparison.days) * innerW);
  const yAt = (value: number) => PAD.t + (1 - (value - yMin) / (yMax - yMin)) * innerH;
  const sofinancePath = comparison.points
    .map((point, index) => `${index === 0 ? "M" : "L"}${xAt(point.day)} ${yAt(new Decimal(point.sofinance).toNumber())}`)
    .join(" ");
  const yTicks = uniqueFinite([0, hi]).sort((a, b) => a - b);
  return {
    xAt,
    yAt,
    sofinancePath,
    xTicks: ticksForDays(comparison.days),
    yTicks,
    target,
    end,
    breakEven: comparison.breakEvenDay,
  };
}

function uniqueFinite(values: number[]): number[] {
  const seen = new Set<string>();
  const out: number[] = [];
  for (const value of values) {
    if (!Number.isFinite(value)) continue;
    const key = value.toFixed(6);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function formatAxisUsdc(value: number): string {
  const amount = new Decimal(value).toDecimalPlaces(value === 0 || Math.abs(value) >= 10 ? 0 : 1);
  if (amount.isZero()) return "0";
  return `${amount.isNegative() ? "−" : "+"}${formatAmount(amount.abs().toFixed())}`;
}
