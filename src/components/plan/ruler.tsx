"use client";

import { useRef, type KeyboardEvent } from "react";
import { cn } from "@/lib/cn";

type RulerProps = {
  label: string;
  /** Snap points, ascending. Spaced evenly on screen, so the scale can be non-linear. */
  stops: readonly number[];
  /** Stops that get a taller tick and a printed label. */
  majors: readonly number[];
  value: number;
  valueText: string;
  onChange: (value: number) => void;
  formatStop: (value: number) => string;
  knobClassName?: string;
};

const MINOR_TICKS = 3;

export function rulerFraction(stops: readonly number[], value: number): number {
  const last = stops.length - 1;
  if (value <= stops[0]!) return 0;
  if (value >= stops[last]!) return 1;
  let index = 0;
  while (index < last && stops[index + 1]! < value) index++;
  const from = stops[index]!;
  const to = stops[index + 1]!;
  return (index + (value - from) / (to - from)) / last;
}

/** Map a pointer X to a stop. Clicks at or past the track's right edge hit the last stop. */
export function pickRulerStop(clientX: number, left: number, width: number, stops: readonly number[]): number {
  const last = stops.length - 1;
  if (last < 0) return 0;
  if (width <= 0 || clientX <= left) return stops[0]!;
  if (clientX >= left + width) return stops[last]!;
  return stops[Math.round(((clientX - left) / width) * last)]!;
}

export function Ruler({ label, stops, majors, value, valueText, onChange, formatStop, knobClassName }: RulerProps) {
  const track = useRef<HTMLDivElement>(null);
  const last = stops.length - 1;
  const fraction = rulerFraction(stops, value);
  const tickCount = last * (MINOR_TICKS + 1) + 1;

  const pick = (clientX: number) => {
    const rect = track.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    onChange(pickRulerStop(clientX, rect.left, rect.width, stops));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const current = Math.round(fraction * last);
    const next =
      event.key === "ArrowRight" || event.key === "ArrowUp" ? current + 1
      : event.key === "ArrowLeft" || event.key === "ArrowDown" ? current - 1
      : event.key === "PageUp" ? current + 3
      : event.key === "PageDown" ? current - 3
      : event.key === "Home" ? 0
      : event.key === "End" ? last
      : null;
    if (next === null) return;
    event.preventDefault();
    onChange(stops[Math.min(last, Math.max(0, next))]!);
  };

  return (
    <div
      className="cursor-ew-resize touch-none px-3 sm:px-4"
      onPointerDown={(event) => {
        try {
          event.currentTarget.setPointerCapture(event.pointerId);
        } catch {
          /* jsdom / happy-dom may not implement pointer capture */
        }
        pick(event.clientX);
      }}
      onPointerMove={(event) => {
        if (event.currentTarget.hasPointerCapture?.(event.pointerId)) pick(event.clientX);
      }}
    >
      <div
        ref={track}
        role="slider"
        tabIndex={0}
        aria-label={label}
        aria-valuemin={stops[0]}
        aria-valuemax={stops[last]}
        aria-valuenow={value}
        aria-valuetext={valueText}
        className="relative h-24 select-none rounded-lg outline-none focus-visible:outline-2 focus-visible:outline-offset-8 focus-visible:outline-ink"
        onKeyDown={onKeyDown}
      >
        {Array.from({ length: tickCount }, (_, tick) => {
          const at = tick / (tickCount - 1);
          const onStop = tick % (MINOR_TICKS + 1) === 0;
          const stop = onStop ? stops[tick / (MINOR_TICKS + 1)]! : null;
          const major = stop !== null && majors.includes(stop);
          return (
            <span
              key={tick}
              aria-hidden="true"
              className={cn(
                "absolute bottom-7 w-px -translate-x-1/2 bg-ink transition-opacity duration-200",
                major ? "h-10" : onStop ? "h-6" : "h-3.5",
                at <= fraction ? "opacity-90" : "opacity-25",
              )}
              style={{ left: `${at * 100}%` }}
            />
          );
        })}
        {majors.map((stop) => (
          <span
            key={stop}
            aria-hidden="true"
            className="absolute bottom-0 -translate-x-1/2 font-data text-[11px] tracking-wide text-ink/60"
            style={{ left: `${(stops.indexOf(stop) / last) * 100}%` }}
          >
            {formatStop(stop)}
          </span>
        ))}
        <span
          aria-hidden="true"
          className="absolute bottom-6 h-[4.25rem] w-[3px] -translate-x-1/2 rounded-full bg-ink transition-[left] duration-150 ease-out"
          style={{ left: `${fraction * 100}%` }}
        >
          <span
            className={cn(
              "absolute -top-2 left-1/2 h-[18px] w-[18px] -translate-x-1/2 rounded-full border-[3px] border-ink bg-cream",
              knobClassName,
            )}
          />
        </span>
      </div>
    </div>
  );
}
