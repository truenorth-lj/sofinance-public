import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { buildPlanComparison, planEntryCost } from "@/lib/lp-plan-yield";
import { ComparisonChart } from "./comparison-chart";
import type { Intent } from "@/lib/lp-intent";

const intent: Intent = {
  days: 2,
  amount: "1000",
  goal: "net-by-date",
  target: "3",
  lossAlert: "50",
  exitAsset: "usdc",
};

describe("ComparisonChart", () => {
  it("renders both curves, the honesty label, and the vs-hold annotation", () => {
    const comparison = buildPlanComparison({
      capital: "1000",
      days: 2,
      aprPct: "36.5",
      sampleDays: 29,
      target: "3",
      entryCost: planEntryCost("1000"),
    });
    const markup = renderToStaticMarkup(
      createElement(ComparisonChart, { status: "ready", comparison, intent }),
    );
    expect(markup).toContain("SoFinance vs hold");
    expect(markup).toContain("Estimate from past average yield, not a forecast");
    expect(markup).toContain("vs hold");
    expect(markup).toContain("aim +3");
    expect(markup).toContain("hold");
    expect(markup).toContain("SoFinance");
    expect(markup).toContain("break-even day 1");
    expect(markup).toContain("#ff9c85");
    expect(markup).toContain("<path");
    expect(markup).toContain("Past average");
    expect(markup).toContain("assumed 50%");
    expect(markup).not.toContain("#f3e76b");
    expect(markup).not.toContain("Sideways");
    expect(markup).not.toContain("&quot;");
  });

  it("clamps an oversized aim and marks when the curve crosses it", () => {
    const comparison = buildPlanComparison({
      capital: "1000",
      days: 90,
      aprPct: "36.5",
      sampleDays: 29,
      target: "400",
      entryCost: planEntryCost("1000"),
    });
    const markup = renderToStaticMarkup(
      createElement(ComparisonChart, {
        status: "ready",
        comparison,
        intent: { ...intent, days: 90, target: "400" },
      }),
    );
    expect(markup).toContain("aim +400 above");
    expect(markup).not.toContain("aim reached on day");
  });

  it("marks the day the curve reaches an in-range aim", () => {
    const comparison = buildPlanComparison({
      capital: "1000",
      days: 10,
      aprPct: "36.5",
      sampleDays: 29,
      target: "3",
      entryCost: planEntryCost("1000"),
    });
    expect(comparison.daysToTarget).toBe(4);
    const markup = renderToStaticMarkup(
      createElement(ComparisonChart, {
        status: "ready",
        comparison,
        intent: { ...intent, days: 10, target: "3" },
      }),
    );
    expect(markup).toContain("aim reached on day 4");
    expect(markup).toContain("aim +3");
    expect(markup).not.toContain("above");
  });

  it("uses the singular in the accessible label after 1 day", () => {
    const comparison = buildPlanComparison({
      capital: "1000",
      days: 1,
      aprPct: "36.5",
      sampleDays: 1,
      target: "1",
      entryCost: planEntryCost("1000"),
    });
    const markup = renderToStaticMarkup(
      createElement(ComparisonChart, {
        status: "ready",
        comparison,
        intent: { ...intent, days: 1, target: "1" },
      }),
    );
    expect(markup).toContain("after 1 day");
    expect(markup).not.toContain("after 1 days");
  });

  it("warns when the sample is too short and does not treat it as normal", () => {
    const comparison = buildPlanComparison({
      capital: "10000",
      days: 30,
      aprPct: "141.8",
      sampleDays: 3,
      target: "1000",
      entryCost: planEntryCost("10000"),
    });
    const markup = renderToStaticMarkup(
      createElement(ComparisonChart, {
        status: "ready",
        comparison,
        intent: { ...intent, days: 30, amount: "10000", target: "1000" },
      }),
    );
    expect(markup).toContain("Only 3 complete UTC days of data");
    expect(markup).toContain("this estimate is unreliable");
  });

  it("says break-even is not within the period when the curve stays negative", () => {
    const comparison = buildPlanComparison({
      capital: "1000",
      days: 1,
      aprPct: "0",
      sampleDays: 8,
      target: "10",
      entryCost: planEntryCost("1000"),
    });
    const markup = renderToStaticMarkup(
      createElement(ComparisonChart, {
        status: "ready",
        comparison,
        intent: { ...intent, days: 1, target: "10" },
      }),
    );
    expect(markup).toContain("break-even not within this period");
    expect(markup).not.toContain("break-even day 1");
  });

  it("shows a clear empty state when no pool is chosen", () => {
    const markup = renderToStaticMarkup(
      createElement(ComparisonChart, { status: "idle", comparison: null, intent }),
    );
    expect(markup).toContain("Until a pool is chosen, there is no yield to plot");
    expect(markup).not.toContain("<path");
  });
});
