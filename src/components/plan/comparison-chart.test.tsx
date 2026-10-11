import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { buildPlanComparison, planEntryCost } from "@/lib/lp-plan-yield";
import { ComparisonChart } from "./comparison-chart";

function plan(input: { capital?: string; days: number; aprPct?: string; sampleDays?: number; windowDays?: number }) {
  const capital = input.capital ?? "1000";
  return buildPlanComparison({
    capital,
    days: input.days,
    aprPct: input.aprPct ?? "36.5",
    sampleDays: input.sampleDays ?? 29,
    aprWindowDays: input.windowDays ?? 30,
    entryCost: planEntryCost(capital),
  });
}

function render(comparison: ReturnType<typeof plan>) {
  return renderToStaticMarkup(createElement(ComparisonChart, { status: "ready", comparison }));
}

describe("ComparisonChart", () => {
  it("renders both curves, the honesty label, and the vs-hold annotation", () => {
    const markup = render(plan({ days: 12, windowDays: 7 }));
    expect(markup).toContain("SoFinance vs hold");
    expect(markup).toContain("Best case from past yield, not a forecast");
    expect(markup).toContain("vs hold");
    expect(markup).toContain("hold");
    expect(markup).toContain("SoFinance");
    expect(markup).toContain("break-even day 10");
    expect(markup).toContain("#ff9c85");
    expect(markup).toContain("<path");
    expect(markup).toContain(
      "Best case from fee income only, with daily auto-compounding and a flat hold for a two-sided same-asset pair. Creating the position and adding liquidity typically costs around 1%, and Day 0 subtracts that from the deposit; network fees are ignored. This is not a probability and not a promise.",
    );
    expect(markup).not.toMatch(/bps|swap fee|assumed 50%/i);
    expect(markup).not.toContain("#f3e76b");
    expect(markup).not.toContain("Sideways");
    expect(markup).not.toContain("&quot;");
  });

  it("names the best APY, its window and its sample in the legend", () => {
    const markup = render(plan({ days: 30, aprPct: "36.5", windowDays: 7, sampleDays: 7 }));
    expect(markup).toContain("Best APY 44%");
    expect(markup).toContain("7-day average fee APR of 36.5%");
    expect(markup).toContain("7 complete UTC days");
  });

  it("has no aim line, aim label or aim legend", () => {
    const markup = render(plan({ days: 90 }));
    expect(markup).not.toMatch(/aim|Your aim/i);
  });

  it("uses the singular in the accessible label after 1 day", () => {
    const markup = render(plan({ days: 1, sampleDays: 1 }));
    expect(markup).toContain("after 1 day");
    expect(markup).not.toContain("after 1 days");
  });

  it("warns when the sample is too short and does not treat it as normal", () => {
    const markup = render(plan({ capital: "10000", days: 30, aprPct: "141.8", sampleDays: 3 }));
    expect(markup).toContain("Only 3 complete UTC days of data");
    expect(markup).toContain("this estimate is unreliable");
  });

  it("says break-even is not within the period when the curve stays negative", () => {
    const markup = render(plan({ days: 1, aprPct: "0", sampleDays: 8 }));
    expect(markup).toContain("break-even not within this period");
    expect(markup).not.toContain("break-even day 10");
  });

  it("shows a clear empty state when no pool is chosen", () => {
    const markup = renderToStaticMarkup(createElement(ComparisonChart, { status: "idle", comparison: null }));
    expect(markup).toContain("Until a pool is chosen, there is no yield to plot");
    expect(markup).not.toContain("<path");
  });
});
