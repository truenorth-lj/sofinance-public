import { describe, expect, it } from "vitest";
import {
  breakEvenInPeriod,
  formatAxisUsdc,
  holdPlotY,
  placeChartLabels,
  planAimPlacement,
  planChartScale,
  xTicksForDays,
  yTicksForScale,
} from "./lp-plan-chart";

describe("planChartScale", () => {
  it("fits the SoFinance series and ignores an oversized aim", () => {
    const scale = planChartScale([-0.5, 4, 16]);
    expect(scale.yMin).toBeLessThan(-2);
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

describe("formatAxisUsdc", () => {
  it("normalizes negative zero and crowded tiny values to 0", () => {
    expect(formatAxisUsdc(-0)).toBe("0");
    expect(formatAxisUsdc(-1e-12)).toBe("0");
    expect(formatAxisUsdc(-0.04)).toBe("0");
    expect(formatAxisUsdc(-0.5)).toBe("−0.5");
    expect(formatAxisUsdc(15.41)).toBe("+15");
  });
});

describe("xTicksForDays", () => {
  it("drops a 360 tick that would collide with 365d", () => {
    expect(xTicksForDays(365, 650, 36)).toEqual([0, 60, 120, 180, 240, 300, 365]);
    expect(xTicksForDays(365, 650, 36)).not.toContain(360);
  });

  it("keeps both ends of a 1-day horizon", () => {
    expect(xTicksForDays(1, 400)).toEqual([0, 1]);
  });
});

describe("yTicksForScale", () => {
  it("keeps 0 and a nice high tick, and drops a -0.5 that sits on zero", () => {
    const ticks = yTicksForScale(-0.6, 18, [-0.5, 0, 15.4], 40, 28);
    expect(ticks).toContain(0);
    expect(ticks.some((value) => value > 10)).toBe(true);
    expect(ticks).not.toContain(-0.5);
    expect(ticks.every((value) => !Object.is(value, -0))).toBe(true);
  });
});

describe("placeChartLabels", () => {
  const bounds = { x: 0, y: 0, w: 400, h: 200 };

  it("stacks colliding labels and marks a leader on the moved one", () => {
    const placed = placeChartLabels(
      [
        { id: "aim", text: "aim +100", ax: 40, ay: 40, w: 80, h: 14, prefer: "above" },
        { id: "hold", text: "hold", ax: 40, ay: 42, w: 36, h: 14, prefer: "above" },
        { id: "be", text: "break-even day 1", ax: 48, ay: 44, w: 110, h: 14, prefer: "below" },
      ],
      bounds,
    );
    expect(placed).toHaveLength(3);
    const boxes = placed.map((label) => ({ x: label.x, y: label.y, w: label.w, h: label.h }));
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i]!;
        const b = boxes[j]!;
        const overlap = !(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y);
        expect(overlap).toBe(false);
      }
    }
    expect(placed.some((label) => label.leader)).toBe(true);
  });

  it("keeps labels inside the plot bounds", () => {
    const [label] = placeChartLabels(
      [{ id: "end", text: "+15.41", ax: 390, ay: 8, w: 50, h: 14, prefer: "above" }],
      bounds,
    );
    expect(label!.x).toBeGreaterThanOrEqual(0);
    expect(label!.x + label!.w).toBeLessThanOrEqual(400);
    expect(label!.y).toBeGreaterThanOrEqual(0);
  });
});

describe("breakEvenInPeriod", () => {
  it("hides a crossing that falls after the chosen horizon", () => {
    expect(breakEvenInPeriod(1, 1)).toBe(1);
    expect(breakEvenInPeriod(5, 1)).toBeNull();
    expect(breakEvenInPeriod(null, 30)).toBeNull();
  });
});
