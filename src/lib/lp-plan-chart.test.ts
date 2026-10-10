import { describe, expect, it } from "vitest";
import { holdPlotY, planAimPlacement, planChartScale } from "./lp-plan-chart";

describe("planChartScale", () => {
  it("fits the SoFinance series and ignores an oversized aim", () => {
    const scale = planChartScale([-0.5, 4, 16]);
    expect(scale.yMin).toBeLessThan(0);
    expect(scale.yMax).toBeGreaterThan(16);
    expect(scale.yMax).toBeLessThan(40);
    expect(planAimPlacement(400, scale.yMax).kind).toBe("above");
    expect(planAimPlacement(400, scale.yMax).plotY).toBe(scale.yMax);
  });

  it("keeps an in-range aim on the plot", () => {
    const scale = planChartScale([-0.5, 16]);
    expect(planAimPlacement(10, scale.yMax).kind).toBe("in-plot");
    expect(planAimPlacement(10, scale.yMax).plotY).toBe(10);
  });
});

describe("holdPlotY", () => {
  it("offsets a hold line that sits on the x-axis", () => {
    expect(holdPlotY(244, 244)).toBe(238);
    expect(holdPlotY(180, 244)).toBe(180);
  });
});
