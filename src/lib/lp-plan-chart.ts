/** Y-domain from the SoFinance series only — an oversized aim must not squash the curve. */
export function planChartScale(values: readonly number[]): { yMin: number; yMax: number } {
  if (values.length === 0) return { yMin: 0, yMax: 1 };
  const lo = Math.min(0, ...values);
  const hi = Math.max(0.01, ...values);
  const pad = Math.max((hi - lo) * 0.12, 0.25);
  const yMax = hi + pad;
  if (lo >= 0) return { yMin: 0, yMax };
  const visible = Math.max(Math.abs(lo) + pad, hi * 0.2, 0.75);
  return { yMin: -visible, yMax };
}

export type PlanAimPlacement = { kind: "in-plot" | "above"; plotY: number };

/** Clamp an aim that sits above the SoFinance domain to the top of the plot. */
export function planAimPlacement(target: number, yMax: number): PlanAimPlacement {
  if (target > yMax) return { kind: "above", plotY: yMax };
  return { kind: "in-plot", plotY: target };
}

/** Nudge a hold/zero line off the x-axis so it cannot be read as the baseline. */
export function holdPlotY(zeroY: number, axisY: number, minGap = 6): number {
  return Math.abs(zeroY - axisY) < minGap ? zeroY - minGap : zeroY;
}

export function normalizeTick(value: number): number {
  if (!Number.isFinite(value) || Object.is(value, -0) || Math.abs(value) < 1e-9) return 0;
  return value;
}

/** "-0.5" / "+15" / "0". Negative zero and sub-cent values become "0". */
export function formatAxisUsdc(value: number): string {
  const n = normalizeTick(value);
  const places = n === 0 || Math.abs(n) >= 10 ? 0 : 1;
  const rounded = Number(n.toFixed(places));
  if (rounded === 0 || Object.is(rounded, -0)) return "0";
  const abs = Math.abs(rounded);
  const text = places === 0 ? String(Math.round(abs)) : abs.toFixed(1);
  return `${rounded < 0 ? "−" : "+"}${text}`;
}

/** Day ticks that keep at least `minPx` between labels, dropping a 360 next to 365d. */
export function xTicksForDays(days: number, innerW: number, minPx = 36): number[] {
  if (days <= 1) return [0, days];
  const step = days <= 10 ? 1 : days <= 45 ? 5 : days <= 120 ? 15 : days <= 240 ? 30 : 60;
  const ticks = [0];
  for (let day = step; day < days; day += step) {
    if (((days - day) / days) * innerW < minPx) break;
    ticks.push(day);
  }
  if (ticks[ticks.length - 1] !== days) ticks.push(days);
  return ticks;
}

/** Nice y-ticks including 0, dropping values that sit on top of each other. */
export function yTicksForScale(
  yMin: number,
  yMax: number,
  values: readonly number[],
  innerH: number,
  minPx = 28,
): number[] {
  const span = yMax - yMin || 1;
  const px = (value: number) => ((value - yMin) / span) * innerH;
  const raw = [0, ...values.map(normalizeTick)].filter((value) => Number.isFinite(value));
  const hi = Math.max(0, ...raw);
  const lo = Math.min(0, ...raw);
  const candidates = [0];
  if (hi > 0) {
    const nice = niceCeil(hi);
    candidates.push(nice <= yMax ? nice : Number(hi.toFixed(hi >= 10 ? 0 : 1)));
  }
  if (lo < 0 && Math.abs(px(lo) - px(0)) >= minPx) candidates.push(Number(lo.toFixed(1)));
  const unique = [...new Set(candidates.map(normalizeTick))].sort((a, b) => a - b);
  const kept: number[] = [];
  for (const value of unique) {
    if (kept.some((prior) => Math.abs(px(value) - px(prior)) < minPx)) continue;
    kept.push(value);
  }
  return kept;
}

export type ChartLabelInput = {
  id: string;
  text: string;
  ax: number;
  ay: number;
  w: number;
  h: number;
  prefer: "above" | "below" | "left" | "right";
};

export type PlacedChartLabel = {
  id: string;
  text: string;
  x: number;
  y: number;
  ax: number;
  ay: number;
  w: number;
  h: number;
  leader: boolean;
};

export type ChartBounds = { x: number; y: number; w: number; h: number };

/**
 * Place labels near their anchors without overlapping. Nudges/stacks first;
 * draws a leader line when the preferred seat is taken.
 */
export function placeChartLabels(
  items: readonly ChartLabelInput[],
  bounds: ChartBounds,
  gap = 4,
): PlacedChartLabel[] {
  const placed: PlacedChartLabel[] = [];
  for (const item of items) {
    const seats = candidateSeats(item, bounds).map((seat) => ({ ...seat, w: item.w, h: item.h }));
    let chosen = seats[0]!;
    let leader = false;
    const free = seats.find((seat) => !placed.some((prior) => boxesOverlap(seat, prior, gap)));
    if (free) {
      chosen = free;
      leader = free !== seats[0];
    } else {
      chosen = nudgeUntilFree(seats[0]!, placed, bounds, gap);
      leader = true;
    }
    placed.push({ ...item, x: chosen.x, y: chosen.y, leader });
  }
  return placed;
}

export function estimateLabelSize(text: string, fontSize: number): { w: number; h: number } {
  return { w: Math.max(12, text.length * fontSize * 0.62), h: fontSize + 4 };
}

export function breakEvenInPeriod(breakEvenDay: number | null, days: number): number | null {
  if (breakEvenDay === null || breakEvenDay > days) return null;
  return breakEvenDay;
}

function niceCeil(value: number): number {
  if (value <= 0) return 0;
  if (value < 1) return Number(value.toFixed(1));
  if (value < 10) return Math.ceil(value);
  const step = value < 50 ? 5 : 10;
  return Math.ceil(value / step) * step;
}

function candidateSeats(item: ChartLabelInput, bounds: ChartBounds): Array<{ x: number; y: number }> {
  const pad = 6;
  const raw: Array<{ x: number; y: number }> = [];
  const above = { x: item.ax + pad, y: item.ay - item.h - 4 };
  const below = { x: item.ax + pad, y: item.ay + 8 };
  const left = { x: item.ax - item.w - pad, y: item.ay - item.h / 2 };
  const right = { x: item.ax + pad, y: item.ay - item.h / 2 };
  const order =
    item.prefer === "above"
      ? [above, below, right, left]
      : item.prefer === "below"
        ? [below, above, right, left]
        : item.prefer === "left"
          ? [left, right, above, below]
          : [right, left, above, below];
  for (const seat of order) raw.push(clampSeat(seat, item.w, item.h, bounds));
  return raw;
}

function clampSeat(seat: { x: number; y: number }, w: number, h: number, bounds: ChartBounds) {
  return {
    x: Math.min(bounds.x + bounds.w - w, Math.max(bounds.x, seat.x)),
    y: Math.min(bounds.y + bounds.h - h, Math.max(bounds.y, seat.y)),
  };
}

function boxesOverlap(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
  gap: number,
): boolean {
  return !(a.x + a.w + gap <= b.x || b.x + b.w + gap <= a.x || a.y + a.h + gap <= b.y || b.y + b.h + gap <= a.y);
}

function nudgeUntilFree(
  start: { x: number; y: number; w: number; h: number },
  others: readonly PlacedChartLabel[],
  bounds: ChartBounds,
  gap: number,
): { x: number; y: number; w: number; h: number } {
  const { x, w, h } = start;
  let { y } = start;
  for (let step = 0; step < 12; step++) {
    const seat = { ...clampSeat({ x, y }, w, h, bounds), w, h };
    if (!others.some((prior) => boxesOverlap(seat, prior, gap))) return seat;
    y += h + gap;
  }
  return { ...clampSeat({ x, y }, w, h, bounds), w, h };
}
