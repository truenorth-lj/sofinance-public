import { describe, expect, it } from "vitest";
import { buildPlanComparison, planEntryCost } from "@/lib/lp-plan-yield";
import { layoutChart } from "./chart-layout";

const comparison = (days: number) =>
  buildPlanComparison({
    capital: "1000",
    days,
    aprPct: "36.5",
    sampleDays: 29,
    aprWindowDays: 30,
    entryCost: planEntryCost("1000"),
  });

const boxesOverlap = (a: { x: number; y: number; w: number; h: number }, b: typeof a) =>
  !(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y);

describe("layoutChart", () => {
  it("places hold, SoFinance, break-even and end labels without overlap on desktop", () => {
    const chart = layoutChart(comparison(30), { width: 720, height: 320, compact: false });
    expect(chart.labels.map((label) => label.id)).toEqual(["hold", "sofinance", "breakeven", "end"]);
    for (let i = 0; i < chart.labels.length; i++) {
      for (let j = i + 1; j < chart.labels.length; j++) {
        expect(boxesOverlap(chart.labels[i]!, chart.labels[j]!)).toBe(false);
      }
    }
  });

  it("drops break-even and end labels on a compact chart and never offers an aim label", () => {
    const chart = layoutChart(comparison(30), { width: 320, height: 262, compact: true });
    expect(chart.labels.map((label) => label.id)).toEqual(["hold", "sofinance"]);
    expect(chart.labels.some((label) => label.id.startsWith("aim"))).toBe(false);
  });

  it("omits the break-even marker when it falls outside the period", () => {
    expect(layoutChart(comparison(5), { width: 720, height: 320, compact: false }).breakEven).toBeNull();
    expect(layoutChart(comparison(30), { width: 720, height: 320, compact: false }).breakEven).toBe(10);
  });

  it("starts the curve below zero because of the day-0 open cost", () => {
    const chart = layoutChart(comparison(30), { width: 720, height: 320, compact: false });
    expect(chart.sofinancePath.startsWith("M52 ")).toBe(true);
    expect(chart.yAt(-10)).toBeGreaterThan(chart.yAt(0));
  });
});
