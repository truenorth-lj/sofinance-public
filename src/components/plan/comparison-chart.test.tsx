import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { buildPlanComparison } from "@/lib/lp-plan-yield";
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
    });
    const markup = renderToStaticMarkup(
      createElement(ComparisonChart, { status: "ready", comparison, intent }),
    );
    expect(markup).toContain("SoFinance vs hold");
    expect(markup).toContain("Estimate from past average yield, not a forecast");
    expect(markup).toContain("+2.00 vs hold");
    expect(markup).toContain("aim +3");
    expect(markup).toContain("<path");
    expect(markup).toContain("Past average");
    expect(markup).not.toContain("Sideways");
    expect(markup).not.toContain("&quot;");
  });

  it("shows a clear empty state when no pool is chosen", () => {
    const markup = renderToStaticMarkup(
      createElement(ComparisonChart, { status: "idle", comparison: null, intent }),
    );
    expect(markup).toContain("Until a pool is chosen, there is no yield to plot");
    expect(markup).not.toContain("<path");
  });
});
