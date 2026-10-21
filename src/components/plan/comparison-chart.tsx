"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { breakEvenInPeriod, formatAxisUsdc } from "@/lib/lp-plan-chart";
import { isThinPlanSample, planOpenCostPctLabel, type PlanYieldComparison } from "@/lib/lp-plan-yield";
import { layoutChart, type ChartBox } from "./chart-layout";
import { bestAprCopy, completeDaysCopy, daysWord, formatPct, formatSigned } from "./format";

const labelPill =
  "inline-flex h-6 items-center whitespace-nowrap rounded-full border border-ink/70 px-2.5 font-data text-[10px] font-normal uppercase tracking-[0.14em]";

export type ChartStatus = "idle" | "loading" | "ready" | "unavailable";

const CORAL = "#ff9c85";
const INK = "#0d0d0c";

export function ComparisonChart({
  status,
  reason,
  comparison,
}: {
  status: ChartStatus;
  reason?: string;
  comparison: PlanYieldComparison | null;
}) {
  return (
    <section
      aria-label="SoFinance versus hold"
      style={{ animationDelay: "160ms" }}
      className="flex min-h-[21rem] animate-rise flex-col rounded-[28px] bg-cream p-4 text-ink motion-reduce:animate-none sm:p-6 lg:col-span-8 lg:col-start-1 lg:row-start-2"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className={labelPill}>SoFinance vs hold</h2>
        <p className="font-data text-[10px] uppercase tracking-[0.14em] text-ink/60">
          Best case from past yield, not a forecast
        </p>
      </div>
      {status === "ready" && comparison ? (
        <ReadyChart comparison={comparison} />
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

function ReadyChart({ comparison }: { comparison: PlanYieldComparison }) {
  const { ref, box } = useChartBox();
  const chart = useMemo(() => layoutChart(comparison, box), [comparison, box]);
  const vsHold = formatSigned(comparison.vsHold);
  const endLabel = formatSigned(comparison.endSofinance);
  const openCostPct = planOpenCostPctLabel();
  const thin = isThinPlanSample(comparison.sampleDays);
  const beInPeriod = breakEvenInPeriod(comparison.breakEvenDay, comparison.days);

  return (
    <div className="mt-5 flex flex-1 flex-col">
      {thin ? (
        <p
          role="status"
          className="mb-3 rounded-2xl border border-ink/20 bg-ink/[0.04] px-3 py-2 text-[13px] leading-snug text-ink"
        >
          Only {completeDaysCopy(comparison.sampleDays)} of data — this estimate is unreliable.
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
          <path d={chart.sofinancePath} fill="none" stroke={INK} strokeWidth="2.25" strokeLinejoin="round" strokeLinecap="round" />
          {chart.breakEven !== null && chart.breakEven > 0 && chart.breakEven < comparison.days ? (
            <circle cx={chart.xAt(chart.breakEven)} cy={chart.yAt(0)} r="4" fill={CORAL} stroke={INK} strokeWidth="1.25" />
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
                fill={INK}
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
        <span>
          Est. best APY {formatPct(comparison.apyPct)} (not guaranteed) · {bestAprCopy({ windowDays: comparison.aprWindowDays, aprPct: comparison.aprPct })} ·{" "}
          {completeDaysCopy(comparison.sampleDays)}
          {thin ? " · unreliable sample" : ""}
        </span>
      </div>
      <p className="mt-3 text-[13px] leading-snug text-ink/65">
        {`Best case from fee income only, with daily auto-compounding and a flat hold for a two-sided same-asset pair. Creating the position and adding liquidity typically costs around ${openCostPct}%, and Day 0 subtracts that from the deposit; network fees are ignored. This is not a probability and not a promise.`}
      </p>
    </div>
  );
}

function useChartBox() {
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<ChartBox>({ width: 720, height: 320, compact: false });

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
