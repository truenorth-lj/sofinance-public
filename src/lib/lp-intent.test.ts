import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import { evaluateIntent, paceToTarget, parseDays, parseUsdc, type Intent } from "./lp-intent";

const NOW = Date.parse("2026-10-10T00:00:00.000Z");
const base: Intent = { days: 30, amount: "1000", goal: "net-by-date", target: "30", lossAlert: "50", exitAsset: "usdc" };

describe("plan input parsing", () => {
  it("accepts grouped decimals and rejects junk, zero and oversize values", () => {
    expect(parseUsdc("1,000.50")).toBe("1000.5");
    expect(parseUsdc("0")).toBeNull();
    expect(parseUsdc("-5")).toBeNull();
    expect(parseUsdc("1e3")).toBeNull();
    expect(parseUsdc("1.1234567")).toBeNull();
    expect(parseUsdc("10000001")).toBeNull();
    expect(parseUsdc("200", "100")).toBeNull();
  });

  it("keeps the horizon within 1–365 whole days", () => {
    expect(parseDays("30")).toBe(30);
    expect(parseDays("0")).toBeNull();
    expect(parseDays("366")).toBeNull();
    expect(parseDays("7.5")).toBeNull();
  });
});

describe("evaluateIntent on the sample paths", () => {
  it("says plainly when the target is out of reach instead of bending the plan", () => {
    const outlook = evaluateIntent(base, NOW);
    expect(outlook.mode).toBe("new");
    expect(outlook.scenarios.map((s) => s.id)).toEqual(["flat", "loss", "tail"]);
    expect(outlook.reached).toBe(0);
    const flat = outlook.scenarios[0]!;
    expect(new Decimal(flat.outcome!).gt(0)).toBe(true);
    expect(new Decimal(flat.shortfall!).plus(flat.outcome!).toFixed()).toBe("30");
    expect(outlook.targetPct).toBe("3");
    expect(outlook.targetAnnualizedPct).toBe("36.5");
  });

  it("discloses the range, fee tier, re-range rule and volume behind the sample paths", () => {
    const outlook = evaluateIntent(base, NOW);
    expect(outlook.assumptions).toEqual({
      rangeLowPct: "-20",
      rangeHighPct: "20",
      feePct: "0.3",
      rerange: { bandLowPct: "-10", bandHighPct: "10", cooldownDays: 1, maxRebalances: 3 },
    });
    expect(outlook.scenarios.map((s) => s.dailyVolume)).toEqual(["10000", "1000", "0"]);
    expect(outlook.scenarios.map((s) => s.priceChangePct)).toEqual(["0", "-30", "-70"]);
  });

  it("flags the loss alert only on paths that breach it", () => {
    const outlook = evaluateIntent(base, NOW);
    expect(outlook.scenarios.map((s) => s.triggersAlert)).toEqual([false, true, true]);
    expect(outlook.alerts).toBe(2);
    expect(outlook.scenarios[1]!.nets.exit).toBe("0");
  });

  it("counts a path as reached once the target is small enough", () => {
    const outlook = evaluateIntent({ ...base, target: "1" }, NOW);
    expect(outlook.scenarios[0]!.reachesTarget).toBe(true);
    expect(outlook.scenarios[0]!.shortfall).toBeNull();
    expect(outlook.reached).toBe(1);
  });

  it("judges beat-holding against the starting basket, not against zero", () => {
    const outlook = evaluateIntent({ ...base, goal: "beat-holding" }, NOW);
    const [flat, loss] = outlook.scenarios;
    // Unchanged price: the basket is worth what went in, so the edge is the hold result.
    expect(new Decimal(flat!.vsHolding!).sub(flat!.nets.hold!).abs().lt("1e-30")).toBe(true);
    expect(flat!.outcome).toBe(flat!.vsHolding);
    // Falling price: the LP trails the basket, but by less than its absolute loss.
    expect(new Decimal(loss!.vsHolding!).lt(0)).toBe(true);
    expect(new Decimal(loss!.vsHolding!).gt(loss!.nets.hold!)).toBe(true);
  });

  it("treats a tracked position as an existing one", () => {
    const outlook = evaluateIntent(base, NOW, "DemoPosition1111111111111111111111111111111");
    expect(outlook.mode).toBe("existing");
    expect(outlook.scenarios[0]!.nets.exit).not.toBe("0");
  });
});

describe("paceToTarget", () => {
  it("finds the first day the steady path covers the target", () => {
    const intent = { ...base, target: "1" };
    const pace = paceToTarget(intent, NOW);
    expect(pace?.scenarioId).toBe("flat");
    const days = pace!.days!;
    expect(evaluateIntent({ ...intent, days }, NOW).scenarios[0]!.reachesTarget).toBe(true);
    if (days > 1) expect(evaluateIntent({ ...intent, days: days - 1 }, NOW).scenarios[0]!.reachesTarget).toBe(false);
  });

  it("returns no day count when a year is not enough", () => {
    expect(paceToTarget({ ...base, target: "500" }, NOW)).toEqual({ scenarioId: "flat", days: null });
  });
});
