"use client";

import { useMemo, useState } from "react";
import {
  calendarizeValues,
  formatAprPct,
  lastCompleteDayAprCopy,
  lastCompleteUtcDayStart,
  lineSegments,
  maxFinite,
  type AprRangeDays,
  type ChartValuePoint,
} from "../lib/apr-series";

export type AprChartSeries = {
  id: string;
  label: string;
  points: Array<{ time: number; date?: string; value: number | null }>;
  stroke: string;
  fillDots?: boolean;
};

const RANGES: AprRangeDays[] = [7, 30, 90];

function formatAxisDate(time: number, range: AprRangeDays) {
  const iso = new Date(time * 1000).toISOString().slice(0, 10);
  if (range === 7) return iso.slice(5);
  return iso.slice(5);
}

export function AprLineChart({
  title,
  subtitle,
  series,
  nowSeconds,
  emptyLabel = "No daily points in this range.",
}: {
  title: string;
  subtitle: string;
  series: AprChartSeries[];
  nowSeconds: number;
  emptyLabel?: string;
}) {
  const seriesEnd = lastCompleteUtcDayStart(nowSeconds);

  const available = useMemo(() => {
    const times = series.flatMap((item) => item.points.filter((p) => p.value !== null).map((p) => p.time));
    if (times.length === 0) return { has90: false };
    const min = Math.min(...times);
    const spanDays = (seriesEnd - min) / 86_400;
    return { has90: spanDays >= 30 };
  }, [series, seriesEnd]);

  const [range, setRange] = useState<AprRangeDays>(30);
  const [hover, setHover] = useState<{ index: number; x: number; y: number } | null>(null);

  const ranged = useMemo(() => {
    return series.map((item) => {
      const known = new Map<number, number | null>();
      for (const point of item.points) known.set(point.time, point.value);
      return { ...item, values: calendarizeValues(known, seriesEnd, range) };
    });
  }, [range, series, seriesEnd]);

  const axis = ranged[0]?.values ?? [];
  const allValues = ranged.flatMap((item) => item.values.map((p) => p.value));
  const hasData = allValues.some((value) => value !== null);
  const yMax = Math.max(maxFinite(allValues) * 1.1, 1);
  const width = 640;
  const height = 220;
  const pad = { l: 44, r: 12, t: 16, b: 28 };
  const innerW = width - pad.l - pad.r;
  const innerH = height - pad.t - pad.b;

  const xAt = (index: number, count: number) =>
    pad.l + (count <= 1 ? innerW / 2 : (index / (count - 1)) * innerW);
  const yAt = (value: number) => pad.t + (1 - value / yMax) * innerH;

  const hoverPoint = hover ? axis[hover.index] : null;

  return (
    <div className="rounded-xl border border-neutral-800/60 bg-neutral-900/30 p-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-neutral-100">{title}</h3>
          <p className="mt-1 max-w-2xl text-[11px] leading-5 text-neutral-500">{subtitle}</p>
        </div>
        <div className="flex shrink-0 gap-1" role="group" aria-label="APR range">
          {RANGES.map((days) => (
            <button
              key={days}
              type="button"
              onClick={() => {
                setRange(days);
                setHover(null);
              }}
              className={`rounded-lg border px-2 py-1 text-[11px] font-semibold ${
                range === days
                  ? "border-neutral-500 bg-neutral-800 text-neutral-100"
                  : "border-neutral-800 bg-transparent text-neutral-400 hover:border-neutral-700 hover:text-neutral-200"
              }`}
            >
              {days}D
            </button>
          ))}
        </div>
      </div>

      {!hasData ? (
        <p className="mt-6 text-xs text-neutral-500">{emptyLabel}</p>
      ) : (
        <div className="relative mt-3">
          <svg
            viewBox={`0 0 ${width} ${height}`}
            className="h-auto w-full"
            role="img"
            aria-label={title}
            onMouseLeave={() => setHover(null)}
            onMouseMove={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              const x = ((event.clientX - rect.left) / rect.width) * width;
              if (axis.length === 0) return;
              const index = Math.min(
                axis.length - 1,
                Math.max(0, Math.round(((x - pad.l) / innerW) * (axis.length - 1))),
              );
              setHover({ index, x: event.clientX - rect.left, y: event.clientY - rect.top });
            }}
          >
            <line x1={pad.l} y1={pad.t} x2={pad.l} y2={height - pad.b} stroke="#404040" strokeWidth="1" />
            <line
              x1={pad.l}
              y1={height - pad.b}
              x2={width - pad.r}
              y2={height - pad.b}
              stroke="#404040"
              strokeWidth="1"
            />
            {[0, 0.5, 1].map((frac) => {
              const value = yMax * frac;
              const y = yAt(value);
              return (
                <g key={frac}>
                  <line x1={pad.l} y1={y} x2={width - pad.r} y2={y} stroke="#262626" strokeWidth="1" />
                  <text x={pad.l - 6} y={y + 3} textAnchor="end" fill="#737373" fontSize="10">
                    {formatAprPct(value)}
                  </text>
                </g>
              );
            })}
            {axis.filter((_, index) => {
              const step = range === 7 ? 1 : range === 30 ? 5 : 15;
              return index % step === 0 || index === axis.length - 1;
            }).map((point) => {
              const index = axis.findIndex((row) => row.time === point.time);
              return (
                <text
                  key={point.time}
                  x={xAt(index, axis.length)}
                  y={height - 8}
                  textAnchor="middle"
                  fill="#737373"
                  fontSize="10"
                >
                  {formatAxisDate(point.time, range)}
                </text>
              );
            })}
            {ranged.map((item) => {
              const segments = lineSegments(item.values);
              return (
                <g key={item.id}>
                  {segments.map((segment, segIndex) => {
                    if (segment.length === 1) return null;
                    const d = segment
                      .map((point, index) => {
                        const x = xAt(axis.findIndex((row) => row.time === point.time), axis.length);
                        const y = yAt(point.value as number);
                        return `${index === 0 ? "M" : "L"}${x} ${y}`;
                      })
                      .join(" ");
                    return (
                      <path
                        key={`${item.id}-${segIndex}`}
                        d={d}
                        fill="none"
                        stroke={item.stroke}
                        strokeWidth="1.75"
                        strokeLinejoin="round"
                        strokeLinecap="round"
                      />
                    );
                  })}
                  {item.values.map((point, index) => {
                    if (point.value === null) return null;
                    if (!item.fillDots && !(hover && hover.index === index)) return null;
                    return (
                      <circle
                        key={`${item.id}-dot-${point.time}`}
                        cx={xAt(index, axis.length)}
                        cy={yAt(point.value)}
                        r={item.fillDots ? 2.5 : 3}
                        fill={item.stroke}
                      />
                    );
                  })}
                </g>
              );
            })}
            {hover && hoverPoint && (
              <line
                x1={xAt(hover.index, axis.length)}
                y1={pad.t}
                x2={xAt(hover.index, axis.length)}
                y2={height - pad.b}
                stroke="#737373"
                strokeDasharray="3 3"
              />
            )}
          </svg>
          {hover && hoverPoint && (
            <div
              className="pointer-events-none absolute z-10 min-w-[140px] rounded-lg border border-neutral-700 bg-[#0a0a0a] px-2 py-1.5 text-[11px] text-neutral-200 shadow-lg"
              style={{
                left: Math.min(hover.x + 12, 280),
                top: Math.max(8, hover.y - 48),
              }}
            >
              <div className="font-semibold text-neutral-100">{hoverPoint.date}</div>
              {ranged.map((item) => {
                const point = item.values[hover.index];
                return (
                  <div key={item.id} className="mt-0.5 text-neutral-400">
                    {item.label}:{" "}
                    <span className="text-neutral-200">
                      {point?.value === null || point?.value === undefined ? "—" : formatAprPct(point.value)}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      <div className="mt-3 flex flex-wrap gap-3 text-[10px] text-neutral-500">
        {ranged.map((item) => (
          <span key={item.id} className="inline-flex items-center gap-1.5">
            <span className="inline-block h-1.5 w-4 rounded-full" style={{ background: item.stroke }} />
            {item.label}
          </span>
        ))}
        {!available.has90 && range === 90 && (
          <span>90D shows gaps before Raydium 30-day TVL history.</span>
        )}
      </div>
    </div>
  );
}

export function AprSparkline({
  points,
  nowSeconds,
  label,
}: {
  points: ChartValuePoint[];
  nowSeconds: number;
  label: string;
}) {
  const known = new Map<number, number | null>();
  for (const point of points) known.set(point.time, point.value);
  const values = calendarizeValues(known, lastCompleteUtcDayStart(nowSeconds), 30);
  const segments = lineSegments(values);
  const width = 88;
  const height = 28;
  const yMax = Math.max(maxFinite(values.map((p) => p.value)) * 1.05, 1);
  const xAt = (index: number) => (values.length <= 1 ? width / 2 : (index / (values.length - 1)) * width);
  const yAt = (value: number) => height - (value / yMax) * (height - 2) - 1;
  const latest = [...values].reverse().find((p) => p.value !== null);
  const lastCopy =
    latest && latest.value !== null ? lastCompleteDayAprCopy(latest.date, latest.value) : null;

  if (segments.length === 0) {
    return (
      <span className="text-[11px] text-neutral-600" title={label}>
        —
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-2" title={`${label} · ${lastCopy?.title ?? ""}`.trim()}>
      <svg viewBox={`0 0 ${width} ${height}`} className="h-7 w-[88px]" aria-hidden>
        {segments.map((segment, segIndex) => {
          if (segment.length === 1) {
            const index = values.findIndex((row) => row.time === segment[0]!.time);
            return (
              <circle key={segIndex} cx={xAt(index)} cy={yAt(segment[0]!.value as number)} r="1.5" fill="#e5e5e5" />
            );
          }
          const d = segment
            .map((point, index) => {
              const x = xAt(values.findIndex((row) => row.time === point.time));
              const y = yAt(point.value as number);
              return `${index === 0 ? "M" : "L"}${x} ${y}`;
            })
            .join(" ");
          return <path key={segIndex} d={d} fill="none" stroke="#e5e5e5" strokeWidth="1.25" />;
        })}
      </svg>
      <span className="tabular-nums text-[11px] text-neutral-300">
        {lastCopy?.label ?? "—"}
      </span>
    </span>
  );
}
