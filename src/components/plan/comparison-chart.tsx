"use client";

import { useMemo } from "react";
import Decimal from "decimal.js";
import type { Intent } from "@/lib/lp-intent";
import { holdPlotY, planAimPlacement, planChartScale } from "@/lib/lp-plan-chart";
import { PLAN_PROTOCOL_FEE_BPS, PLAN_SWAP_SHARE, type PlanYieldComparison } from "@/lib/lp-plan-yield";
import { daysWord, formatAmount, formatPct, formatSigned } from "./format";

const labelPill =
  "inline-flex h-6 items-center whitespace-nowrap rounded-full border border-ink/70 px-2.5 font-data text-[10px] font-normal uppercase tracking-[0.14em]";

export type ChartStatus = "idle" | "loading" | "ready" | "unavailable";

const WIDTH = 720;
const HEIGHT = 340;
const PAD = { l: 54, r: 18, t: 34, b: 40 };
const CORAL = "#ff9c85";
const INK = "#0d0d0c";

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
      className="flex min-h-[21rem] animate-rise flex-col rounded-[28px] bg-cream p-4 text-ink motion-reduce:animate-none sm:p-6 lg:col-span-8"
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
  const swapPct = new Decimal(PLAN_SWAP_SHARE).mul(100).toFixed(0);

  return (
    <div className="mt-5 flex flex-1 flex-col">
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="h-auto w-full min-h-[12.5rem] sm:min-h-0"
        role="img"
        aria-label={`SoFinance estimated ${endLabel} USDC versus hold after ${comparison.days} ${daysWord(comparison.days)}`}
      >
        <line x1={PAD.l} y1={PAD.t} x2={PAD.l} y2={HEIGHT - PAD.b} stroke={INK} strokeOpacity="0.28" />
        <line x1={PAD.l} y1={HEIGHT - PAD.b} x2={WIDTH - PAD.r} y2={HEIGHT - PAD.b} stroke={INK} strokeOpacity="0.28" />
        {chart.yTicks.map((value) => (
          <g key={value}>
            <line
              x1={PAD.l}
              y1={chart.yAt(value)}
              x2={WIDTH - PAD.r}
              y2={chart.yAt(value)}
              stroke={INK}
              strokeOpacity="0.08"
            />
            <text
              x={PAD.l - 8}
              y={chart.yAt(value) + 3}
              textAnchor="end"
              fill="#98948b"
              fontSize="12"
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
            fontSize="12"
            fontFamily="ui-monospace, SFMono-Regular, monospace"
          >
            {day === comparison.days ? `${day}d` : String(day)}
          </text>
        ))}
        <line
          x1={PAD.l}
          y1={chart.holdY}
          x2={WIDTH - PAD.r}
          y2={chart.holdY}
          stroke="#6b6760"
          strokeWidth="1.75"
          strokeDasharray="5 4"
        />
        <text
          x={PAD.l + 8}
          y={chart.holdY - 6}
          fill={INK}
          fillOpacity="0.7"
          fontSize="12"
          fontFamily="ui-monospace, SFMono-Regular, monospace"
        >
          hold
        </text>
        {chart.aim.kind === "above" ? (
          <g>
            <line
              x1={PAD.l}
              y1={PAD.t}
              x2={WIDTH - PAD.r}
              y2={PAD.t}
              stroke={CORAL}
              strokeWidth="1.75"
              strokeDasharray="5 4"
            />
            <text
              x={WIDTH - PAD.r}
              y={PAD.t - 8}
              textAnchor="end"
              fill={CORAL}
              fontSize="12"
              fontFamily="ui-monospace, SFMono-Regular, monospace"
            >
              {`aim +${formatAmount(intent.target)} above`}
            </text>
          </g>
        ) : (
          <g>
            <line
              x1={PAD.l}
              y1={chart.yAt(chart.aim.plotY)}
              x2={WIDTH - PAD.r}
              y2={chart.yAt(chart.aim.plotY)}
              stroke={CORAL}
              strokeWidth="1.75"
              strokeDasharray="5 4"
            />
            <text
              x={PAD.l + 8}
              y={chart.yAt(chart.aim.plotY) - 6}
              fill={CORAL}
              fontSize="12"
              fontFamily="ui-monospace, SFMono-Regular, monospace"
            >
              {`aim +${formatAmount(intent.target)}`}
            </text>
          </g>
        )}
        <path d={chart.sofinancePath} fill="none" stroke={INK} strokeWidth="2.25" strokeLinejoin="round" strokeLinecap="round" />
        <text
          x={chart.sofinanceLabel.x}
          y={chart.sofinanceLabel.y}
          fill={INK}
          fontSize="12"
          fontFamily="ui-monospace, SFMono-Regular, monospace"
        >
          SoFinance
        </text>
        {chart.breakEven !== null && chart.breakEven > 0 && chart.breakEven <= comparison.days && (
          <g>
            {chart.breakEven < comparison.days ? (
              <circle cx={chart.xAt(chart.breakEven)} cy={chart.yAt(0)} r="4.5" fill={CORAL} stroke={INK} strokeWidth="1.25" />
            ) : null}
            <text
              x={Math.min(chart.xAt(chart.breakEven) + 10, WIDTH - PAD.r - 4)}
              y={chart.yAt(0) + (chart.breakEven < comparison.days ? 16 : -10)}
              fill={INK}
              fontSize="12"
              fontFamily="ui-monospace, SFMono-Regular, monospace"
            >
              {`break-even day ${chart.breakEven}`}
            </text>
          </g>
        )}
        {chart.aimReached !== null && (
          <g>
            <circle
              cx={chart.xAt(chart.aimReached)}
              cy={chart.yAt(chart.aimReachedValue)}
              r="4.5"
              fill={CORAL}
              stroke={INK}
              strokeWidth="1.25"
            />
            <text
              x={Math.min(chart.xAt(chart.aimReached) + 10, WIDTH - PAD.r - 4)}
              y={chart.yAt(chart.aimReachedValue) - 10}
              fill={INK}
              fontSize="12"
              fontFamily="ui-monospace, SFMono-Regular, monospace"
            >
              {`aim reached on day ${chart.aimReached}`}
            </text>
          </g>
        )}
        <circle cx={chart.xAt(comparison.days)} cy={chart.yAt(chart.end)} r="4.5" fill="#84e9c5" stroke={INK} strokeWidth="1.5" />
        <text
          x={chart.xAt(comparison.days) - 8}
          y={chart.yAt(chart.end) - 10}
          textAnchor="end"
          fill={INK}
          fontSize="12"
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
          End {endLabel} · {comparison.days} {daysWord(comparison.days)}
          {comparison.breakEvenDay === null ? "" : ` · break-even day ${comparison.breakEvenDay}`}
        </p>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 font-data text-[10px] uppercase tracking-[0.14em] text-ink/60">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-px w-5 bg-ink" />
          SoFinance
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-px w-5 border-t border-dashed border-[#6b6760]" />
          Hold
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-px w-5 border-t border-dashed border-coral" />
          Your aim
        </span>
        <span>
          Past average {formatPct(comparison.aprPct)} a year · {comparison.sampleDays}{" "}
          {comparison.sampleDays === 1 ? "complete UTC day" : "complete UTC days"}
        </span>
      </div>
      <p className="mt-3 text-[13px] leading-snug text-ink/65">
        Best case from fee income only, with daily auto-compounding and a flat hold for a two-sided same-asset
        pair. Day 0 subtracts the protocol swap fee ({PLAN_PROTOCOL_FEE_BPS} bps) on an assumed {swapPct}% of the
        deposit that must be swapped; network fees are ignored. This is not a probability and not a promise.
      </p>
    </div>
  );
}

function layoutChart(comparison: PlanYieldComparison, intent: Intent) {
  const end = new Decimal(comparison.endSofinance).toNumber();
  const target = new Decimal(intent.target).toNumber();
  const sofinance = comparison.points.map((point) => new Decimal(point.sofinance).toNumber());
  const { yMin, yMax } = planChartScale(sofinance);
  const innerW = WIDTH - PAD.l - PAD.r;
  const innerH = HEIGHT - PAD.t - PAD.b;
  const xAt = (day: number) => PAD.l + (comparison.days <= 0 ? 0 : (day / comparison.days) * innerW);
  const yAt = (value: number) => PAD.t + (1 - (value - yMin) / (yMax - yMin)) * innerH;
  const sofinancePath = comparison.points
    .map((point, index) => `${index === 0 ? "M" : "L"}${xAt(point.day)} ${yAt(new Decimal(point.sofinance).toNumber())}`)
    .join(" ");
  const yTicks = uniqueFinite([0, end, sofinance[0] ?? 0]).sort((a, b) => a - b);
  const mid = comparison.points[Math.max(1, Math.floor(comparison.points.length * 0.55))]!;
  const midY = yAt(new Decimal(mid.sofinance).toNumber());
  const aimReached =
    comparison.daysToTarget !== null &&
    comparison.daysToTarget > 0 &&
    comparison.daysToTarget <= comparison.days
      ? comparison.daysToTarget
      : null;
  const aimReachedValue =
    aimReached === null ? 0 : new Decimal(comparison.points[aimReached]!.sofinance).toNumber();
  return {
    xAt,
    yAt,
    sofinancePath,
    xTicks: ticksForDays(comparison.days),
    yTicks,
    aim: planAimPlacement(target, yMax),
    end,
    holdY: holdPlotY(yAt(0), HEIGHT - PAD.b),
    breakEven: comparison.breakEvenDay,
    aimReached,
    aimReachedValue,
    sofinanceLabel: {
      x: Math.min(xAt(mid.day) + 8, WIDTH - PAD.r - 70),
      y: midY - 10,
    },
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
