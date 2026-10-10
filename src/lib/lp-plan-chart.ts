/** Y-domain from the SoFinance series only — an oversized aim must not squash the curve. */
export function planChartScale(values: readonly number[]): { yMin: number; yMax: number } {
  if (values.length === 0) return { yMin: 0, yMax: 1 };
  const lo = Math.min(0, ...values);
  const hi = Math.max(0.01, ...values);
  const pad = Math.max((hi - lo) * 0.12, 0.25);
  const yMax = hi + pad;
  if (lo >= 0) return { yMin: 0, yMax };
  // A 50-cent entry cost on a +15 estimate is otherwise a 1-pixel dip.
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
