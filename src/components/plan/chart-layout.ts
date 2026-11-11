import Decimal from "decimal.js";
import {
  breakEvenInPeriod,
  estimateLabelSize,
  holdPlotY,
  placeChartLabels,
  planChartScale,
  type PlacedChartLabel,
  xTicksForDays,
  yTicksForScale,
} from "@/lib/lp-plan-chart";
import type { PlanYieldComparison } from "@/lib/lp-plan-yield";
import { formatSigned } from "./format";

const MIN_LABEL_PX = 11;

export type ChartBox = { width: number; height: number; compact: boolean };

/**
 * How the chart reads the USDC projection. The default plots USDC profit; the share view passes `toDisplay` (profit →
 * shares gained per 100 held), its own end / hold labels, and optionally a lower projection drawn as a range band.
 */
export type ChartView = {
  toDisplay?: (profit: string) => number;
  endText?: string;
  holdText?: string;
  /** A second projection (the lowest recent window) whose curve bounds the band under the best case. */
  low?: PlanYieldComparison | null;
};

/** Pure geometry for the SoFinance-vs-hold chart: scales, ticks, the curve and non-overlapping labels. */
export function layoutChart(
  comparison: PlanYieldComparison,
  box: ChartBox,
  view: ChartView = {},
) {
  const toDisplay = view.toDisplay ?? ((profit: string) => new Decimal(profit).toNumber());
  const font = MIN_LABEL_PX;
  const pad = box.compact
    ? { l: 40, r: 10, t: 20, b: 26 }
    : { l: 52, r: 16, t: 28, b: 34 };
  const end = toDisplay(comparison.endSofinance);
  const sofinance = comparison.points.map((point) => toDisplay(point.sofinance));
  const low = view.low && view.low.days === comparison.days ? view.low.points.map((point) => toDisplay(point.sofinance)) : null;
  const { yMin, yMax } = planChartScale(low ? [...sofinance, ...low] : sofinance);
  const innerW = box.width - pad.l - pad.r;
  const innerH = box.height - pad.t - pad.b;
  const xAt = (day: number) => pad.l + (comparison.days <= 0 ? 0 : (day / comparison.days) * innerW);
  const yAt = (value: number) => pad.t + (1 - (value - yMin) / (yMax - yMin)) * innerH;
  const sofinancePath = comparison.points
    .map((point, index) => `${index === 0 ? "M" : "L"}${xAt(point.day)} ${yAt(sofinance[index]!)}`)
    .join(" ");
  // Closed area from the best curve back along the low curve: the spread of recent windows, not a probability.
  const bandPath = low
    ? `${sofinancePath} ${low
        .map((value, index) => ({ day: comparison.points[index]!.day, value }))
        .reverse()
        .map((point) => `L${xAt(point.day)} ${yAt(point.value)}`)
        .join(" ")} Z`
    : null;
  const holdY = holdPlotY(yAt(0), box.height - pad.b);
  const breakEven = breakEvenInPeriod(comparison.breakEvenDay, comparison.days);
  // Label the curve late in the period, where it has pulled well clear of the hold line.
  const labelPoint = comparison.points[Math.max(1, Math.floor((comparison.points.length - 1) * 0.72))]!;

  const candidates: Array<{
    id: string;
    text: string;
    ax: number;
    ay: number;
    prefer: "above" | "above-left" | "below" | "left" | "right";
    w: number;
    h: number;
  }> = [
    {
      id: "hold",
      text: view.holdText ?? "hold",
      // A longer hold label ("hold 100 SPCX") at the left edge runs into the curve as it crosses near break-even;
      // mid-chart, under the dashed line, it sits where neither the curve nor the band reaches.
      ax: view.holdText ? xAt(comparison.days * 0.5) : pad.l + 10,
      ay: holdY,
      prefer: view.holdText ? ("below" as const) : ("above" as const),
      ...estimateLabelSize(view.holdText ?? "hold", font),
    },
    {
      id: "sofinance",
      text: "SoFinance",
      ax: xAt(labelPoint.day),
      ay: yAt(sofinance[labelPoint.day]!),
      prefer: "above-left" as const,
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
    const endText = view.endText ?? formatSigned(comparison.endSofinance);
    candidates.push({
      id: "end",
      text: endText,
      ax: xAt(comparison.days),
      ay: yAt(end),
      prefer: "left",
      ...estimateLabelSize(endText, font),
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
    bandPath,
    xTicks: xTicksForDays(comparison.days, innerW),
    yTicks: yTicksForScale(yMin, yMax, [0, end, sofinance[0] ?? 0], innerH),
    end,
    holdY,
    breakEven,
    labels,
  };
}
