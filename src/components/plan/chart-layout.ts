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

export const MIN_LABEL_PX = 11;

export type ChartBox = { width: number; height: number; compact: boolean };

/** Pure geometry for the SoFinance-vs-hold chart: scales, ticks, the curve and non-overlapping labels. */
export function layoutChart(
  comparison: PlanYieldComparison,
  box: ChartBox,
) {
  const font = MIN_LABEL_PX;
  const pad = box.compact
    ? { l: 40, r: 10, t: 20, b: 26 }
    : { l: 52, r: 16, t: 28, b: 34 };
  const end = new Decimal(comparison.endSofinance).toNumber();
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
      text: "hold",
      ax: pad.l + 10,
      ay: holdY,
      prefer: "above" as const,
      ...estimateLabelSize("hold", font),
    },
    {
      id: "sofinance",
      text: "SoFinance",
      ax: xAt(labelPoint.day),
      ay: yAt(new Decimal(labelPoint.sofinance).toNumber()),
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
    end,
    holdY,
    breakEven,
    labels,
  };
}
