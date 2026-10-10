"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Decimal from "decimal.js";
import type { Intent } from "@/lib/lp-intent";
import {
  breakEvenInPeriod,
  estimateLabelSize,
  formatAxisUsdc,
  holdPlotY,
  placeChartLabels,
  planAimPlacement,
  planChartScale,
  type PlacedChartLabel,
  xTicksForDays,
  yTicksForScale,
} from "@/lib/lp-plan-chart";
import {
  isThinPlanSample,
  PLAN_PROTOCOL_FEE_BPS,
  PLAN_SWAP_SHARE,
  type PlanYieldComparison,
} from "@/lib/lp-plan-yield";
import { daysWord, formatAmount, formatPct, formatSigned } from "./format";

const labelPill =
  "inline-flex h-6 items-center whitespace-nowrap rounded-full border border-ink/70 px-2.5 font-data text-[10px] font-normal uppercase tracking-[0.14em]";

export type ChartStatus = "idle" | "loading" | "ready" | "unavailable";

const CORAL = "#ff9c85";
const INK = "#0d0d0c";
const AIM_LABEL = INK;
const MIN_LABEL_PX = 11;

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
  const { ref, box } = useChartBox();
  const chart = useMemo(() => layoutChart(comparison, intent, box), [comparison, intent, box]);
  const vsHold = formatSigned(comparison.vsHold);
  const endLabel = formatSigned(comparison.endSofinance);
  const swapPct = new Decimal(PLAN_SWAP_SHARE).mul(100).toFixed(0);
  const thin = isThinPlanSample(comparison.sampleDays);
  const beInPeriod = breakEvenInPeriod(comparison.breakEvenDay, comparison.days);

  return (
    <div className="mt-5 flex flex-1 flex-col">
      {thin ? (
        <p
          role="status"
          className="mb-3 rounded-2xl border border-ink/20 bg-ink/[0.04] px-3 py-2 text-[13px] leading-snug text-ink"
        >
          Only {comparison.sampleDays} {comparison.sampleDays === 1 ? "complete UTC day" : "complete UTC days"} of
          data — this estimate is unreliable.
        </p>
      ) : null}
      <div ref={ref} className="w-full">
        <svg
          viewBox={`0 0 ${box.width} ${box.height}`}
          width={box.width}
          height={box.height}
          className="h-auto max-w-full"
          role="img"
          aria-label={`SoFinance estimated ${endLabel} USDC versus hold after ${comparison.days} ${daysWord(comparison.days)}`}
        >
          <line x1={chart.pad.l} y1={chart.pad.t} x2={chart.pad.l} y2={box.height - chart.pad.b} stroke={INK} strokeOpacity="0.28" />
          <line x1={chart.pad.l} y1={box.height - chart.pad.b} x2={box.width - chart.pad.r} y2={box.height - chart.pad.b} stroke={INK} strokeOpacity="0.28" />
          {chart.yTicks.map((value) => (
            <g key={value}>
              <line
                x1={chart.pad.l}
                y1={chart.yAt(value)}
                x2={box.width - chart.pad.r}
                y2={chart.yAt(value)}
                stroke={INK}
                strokeOpacity="0.08"
              />
              <text
                x={chart.pad.l - 8}
                y={chart.yAt(value) + 4}
                textAnchor="end"
                fill="#6b6760"
                fontSize={chart.font}
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
              y={box.height - 8}
              textAnchor="middle"
              fill="#6b6760"
              fontSize={chart.font}
              fontFamily="ui-monospace, SFMono-Regular, monospace"
            >
              {day === comparison.days ? `${day}d` : String(day)}
            </text>
          ))}
          <line
            x1={chart.pad.l}
            y1={chart.holdY}
            x2={box.width - chart.pad.r}
            y2={chart.holdY}
            stroke="#6b6760"
            strokeWidth="1.75"
            strokeDasharray="5 4"
          />
          {chart.aim.kind === "above" ? (
            <line
              x1={chart.pad.l}
              y1={chart.pad.t}
              x2={box.width - chart.pad.r}
              y2={chart.pad.t}
              stroke={CORAL}
              strokeWidth="1.75"
              strokeDasharray="5 4"
            />
          ) : (
            <line
              x1={chart.pad.l}
              y1={chart.yAt(chart.aim.plotY)}
              x2={box.width - chart.pad.r}
              y2={chart.yAt(chart.aim.plotY)}
              stroke={CORAL}
              strokeWidth="1.75"
              strokeDasharray="5 4"
            />
          )}
          <path d={chart.sofinancePath} fill="none" stroke={INK} strokeWidth="2.25" strokeLinejoin="round" strokeLinecap="round" />
          {chart.breakEven !== null && chart.breakEven > 0 && chart.breakEven < comparison.days ? (
            <circle cx={chart.xAt(chart.breakEven)} cy={chart.yAt(0)} r="4" fill={CORAL} stroke={INK} strokeWidth="1.25" />
          ) : null}
          {chart.aimReached !== null ? (
            <circle
              cx={chart.xAt(chart.aimReached)}
              cy={chart.yAt(chart.aimReachedValue)}
              r="4"
              fill={CORAL}
              stroke={INK}
              strokeWidth="1.25"
            />
          ) : null}
          <circle cx={chart.xAt(comparison.days)} cy={chart.yAt(chart.end)} r="4.5" fill="#84e9c5" stroke={INK} strokeWidth="1.5" />
          {chart.labels.map((label) => (
            <g key={label.id}>
              {label.leader ? (
                <line
                  x1={label.ax}
                  y1={label.ay}
                  x2={label.x + 2}
                  y2={label.y + label.h / 2}
                  stroke={INK}
                  strokeOpacity="0.35"
                  strokeWidth="1"
                />
              ) : null}
              <text
                x={label.x}
                y={label.y + label.h - 3}
                fill={label.id === "aim" ? AIM_LABEL : INK}
                fontSize={chart.font}
                fontFamily="ui-monospace, SFMono-Regular, monospace"
              >
                {label.text}
              </text>
            </g>
          ))}
        </svg>
      </div>

      {box.compact ? (
        <ul className="mt-3 space-y-1 font-data text-[12px] text-ink/80">
          <li>End {endLabel}</li>
          <li>
            {beInPeriod === null
              ? comparison.breakEvenDay === null
                ? "Break-even not reached in a year"
                : "Break-even not within this period"
              : `Break-even day ${beInPeriod}`}
          </li>
          {chart.aimReached !== null ? <li>Aim reached on day {chart.aimReached}</li> : null}
        </ul>
      ) : null}

      <div className="mt-4 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
        <p className="font-data text-[11px] uppercase tracking-[0.14em] text-ink">
          {vsHold} USDC vs hold
        </p>
        <p className="font-data text-[10px] uppercase tracking-[0.14em] text-ink/60">
          End {endLabel} · {comparison.days} {daysWord(comparison.days)}
          {beInPeriod === null ? " · break-even not within this period" : ` · break-even day ${beInPeriod}`}
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
          {thin ? " · unreliable sample" : ""}
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

function useChartBox() {
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ width: 720, height: 320, compact: false });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const apply = (width: number) => {
      const w = Math.max(240, Math.round(width));
      const compact = w < 560;
      const h = Math.round(w * (compact ? 0.82 : 0.44));
      setBox((prev) => (prev.width === w && prev.height === h && prev.compact === compact ? prev : { width: w, height: h, compact }));
    };
    apply(el.clientWidth || 720);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => apply(entries[0]!.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return { ref, box };
}

function layoutChart(
  comparison: PlanYieldComparison,
  intent: Intent,
  box: { width: number; height: number; compact: boolean },
) {
  const font = MIN_LABEL_PX;
  const pad = box.compact
    ? { l: 40, r: 10, t: 20, b: 26 }
    : { l: 52, r: 16, t: 28, b: 34 };
  const end = new Decimal(comparison.endSofinance).toNumber();
  const target = new Decimal(intent.target).toNumber();
  const sofinance = comparison.points.map((point) => new Decimal(point.sofinance).toNumber());
  const { yMin, yMax } = planChartScale(sofinance);
  const innerW = box.width - pad.l - pad.r;
  const innerH = box.height - pad.t - pad.b;
  const xAt = (day: number) => pad.l + (comparison.days <= 0 ? 0 : (day / comparison.days) * innerW);
  const yAt = (value: number) => pad.t + (1 - (value - yMin) / (yMax - yMin)) * innerH;
  const sofinancePath = comparison.points
    .map((point, index) => `${index === 0 ? "M" : "L"}${xAt(point.day)} ${yAt(new Decimal(point.sofinance).toNumber())}`)
    .join(" ");
  const holdY = holdPlotY(yAt(0), box.height - pad.b);
  const aim = planAimPlacement(target, yMax);
  const aimY = aim.kind === "above" ? pad.t : yAt(aim.plotY);
  const breakEven = breakEvenInPeriod(comparison.breakEvenDay, comparison.days);
  const aimReached =
    comparison.daysToTarget !== null &&
    comparison.daysToTarget > 0 &&
    comparison.daysToTarget <= comparison.days
      ? comparison.daysToTarget
      : null;
  const aimReachedValue =
    aimReached === null ? 0 : new Decimal(comparison.points[aimReached]!.sofinance).toNumber();
  const mid = comparison.points[Math.max(1, Math.floor(comparison.points.length * 0.55))]!;

  const candidates: Array<{
    id: string;
    text: string;
    ax: number;
    ay: number;
    prefer: "above" | "below" | "left" | "right";
    w: number;
    h: number;
  }> = [
    {
      id: "hold",
      text: "hold",
      ax: pad.l + 10,
      ay: holdY,
      prefer: "above" as const,
      ...estimateLabelSize("hold", font),
    },
    {
      id: "aim",
      text: aim.kind === "above" ? `aim +${formatAmount(intent.target)} above` : `aim +${formatAmount(intent.target)}`,
      ax: box.compact ? pad.l + 10 : box.width - pad.r - 8,
      ay: aimY,
      prefer: (aim.kind === "above" ? "below" : "above") as "above" | "below",
      ...estimateLabelSize(
        aim.kind === "above" ? `aim +${formatAmount(intent.target)} above` : `aim +${formatAmount(intent.target)}`,
        font,
      ),
    },
    {
      id: "sofinance",
      text: "SoFinance",
      ax: xAt(mid.day),
      ay: yAt(new Decimal(mid.sofinance).toNumber()),
      prefer: "above" as const,
      ...estimateLabelSize("SoFinance", font),
    },
  ];
  if (!box.compact) {
    if (breakEven !== null && breakEven > 0) {
      const text = `break-even day ${breakEven}`;
      candidates.push({
        id: "breakeven",
        text,
        ax: xAt(breakEven),
        ay: yAt(0),
        prefer: "below",
        ...estimateLabelSize(text, font),
      });
    }
    if (aimReached !== null) {
      const text = `aim reached on day ${aimReached}`;
      candidates.push({
        id: "aimReached",
        text,
        ax: xAt(aimReached),
        ay: yAt(aimReachedValue),
        prefer: "above",
        ...estimateLabelSize(text, font),
      });
    }
    candidates.push({
      id: "end",
      text: formatSigned(comparison.endSofinance),
      ax: xAt(comparison.days),
      ay: yAt(end),
      prefer: "left",
      ...estimateLabelSize(formatSigned(comparison.endSofinance), font),
    });
  }

  const labels: PlacedChartLabel[] = placeChartLabels(candidates, {
    x: pad.l,
    y: 2,
    w: box.width - pad.l - pad.r,
    h: box.height - 4,
  });

  return {
    pad,
    font,
    xAt,
    yAt,
    sofinancePath,
    xTicks: xTicksForDays(comparison.days, innerW),
    yTicks: yTicksForScale(yMin, yMax, [0, end, sofinance[0] ?? 0], innerH),
    aim,
    end,
    holdY,
    breakEven,
    aimReached,
    aimReachedValue,
    labels,
  };
}
