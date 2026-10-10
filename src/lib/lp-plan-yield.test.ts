import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import {
  averageCompleteDayAprPct,
  breakEvenDay,
  buildPlanComparison,
  compoundedProfit,
  dailyRateFromAprPct,
  daysToReachGain,
  planEntryCost,
  PLAN_PROTOCOL_FEE_BPS,
  PLAN_SWAP_SHARE,
  PLAN_YIELD_DAYS_PER_YEAR,
} from "./lp-plan-yield";

const D = Decimal.clone({ precision: 60 });

describe("averageCompleteDayAprPct", () => {
  it("averages only finite complete-day points and skips gaps", () => {
    expect(
      averageCompleteDayAprPct([
        { aprPct: 10 },
        { aprPct: null },
        { aprPct: 20 },
        { aprPct: Number.NaN },
        { aprPct: Number.POSITIVE_INFINITY },
      ]),
    ).toBe("15");
  });

  it("returns null when every day is a gap", () => {
    expect(averageCompleteDayAprPct([])).toBeNull();
    expect(averageCompleteDayAprPct([{ aprPct: null }, { aprPct: Number.NaN }])).toBeNull();
  });
});

describe("daily compounding", () => {
  it("turns a 36.5% APR into a 0.1% daily rate", () => {
    expect(dailyRateFromAprPct("36.5").toFixed()).toBe("0.001");
    expect(PLAN_YIELD_DAYS_PER_YEAR).toBe(365);
  });

  it("compounds once on a 1-day horizon", () => {
    const rate = dailyRateFromAprPct("36.5");
    expect(compoundedProfit("1000", rate, 0).toFixed()).toBe("0");
    expect(compoundedProfit("1000", rate, 1).toFixed()).toBe("1");
  });

  it("matches (1+r)^n − 1 on a 365-day horizon", () => {
    const rate = dailyRateFromAprPct("36.5");
    const expected = new D(1000).mul(rate.add(1).pow(365)).sub(1000);
    expect(compoundedProfit("1000", rate, 365).toFixed()).toBe(expected.toFixed());
  });

  it("stays flat when the average yield is zero", () => {
    const rate = dailyRateFromAprPct("0");
    expect(compoundedProfit("1000", rate, 1).toFixed()).toBe("0");
    expect(compoundedProfit("1000", rate, 365).toFixed()).toBe("0");
  });

  it("subtracts a day-0 entry cost without compounding it", () => {
    const rate = dailyRateFromAprPct("36.5");
    expect(compoundedProfit("1000", rate, 0, "2").toFixed()).toBe("-2");
    expect(compoundedProfit("1000", rate, 1, "2").toFixed()).toBe("-1");
  });
});

describe("breakEvenDay", () => {
  it("is day 0 when there is no entry cost and the rate is not negative", () => {
    expect(breakEvenDay("1000", dailyRateFromAprPct("10"))).toBe(0);
    expect(breakEvenDay("1000", dailyRateFromAprPct("0"))).toBe(0);
  });

  it("returns null when yield is zero and an entry cost remains", () => {
    expect(breakEvenDay("1000", dailyRateFromAprPct("0"), "2")).toBeNull();
  });

  it("finds the first day a positive rate covers the entry cost", () => {
    const rate = dailyRateFromAprPct("36.5");
    expect(breakEvenDay("1000", rate, "2")).toBe(2);
    expect(compoundedProfit("1000", rate, 1, "2").lt(0)).toBe(true);
    expect(compoundedProfit("1000", rate, 2, "2").gte(0)).toBe(true);
  });

  it("returns null when a negative rate never recovers", () => {
    expect(breakEvenDay("1000", dailyRateFromAprPct("-10"), "1")).toBeNull();
    expect(breakEvenDay("1000", dailyRateFromAprPct("-10"))).toBeNull();
  });
});

describe("daysToReachGain", () => {
  it("returns 0 when the target is already met", () => {
    expect(daysToReachGain("1000", dailyRateFromAprPct("10"), "0")).toBe(0);
  });

  it("finds the first day the compounded gain covers the target", () => {
    const rate = dailyRateFromAprPct("36.5");
    expect(daysToReachGain("1000", rate, "1")).toBe(1);
    expect(daysToReachGain("1000", rate, "2")).toBe(2);
  });

  it("returns null when a year is not enough, including zero yield", () => {
    expect(daysToReachGain("1000", dailyRateFromAprPct("0"), "1")).toBeNull();
    expect(daysToReachGain("1000", dailyRateFromAprPct("0.01"), "500")).toBeNull();
  });
});

describe("planEntryCost", () => {
  it("is 10 bps on the swapped half of the deposit", () => {
    expect(PLAN_PROTOCOL_FEE_BPS).toBe(10);
    expect(PLAN_SWAP_SHARE).toBe("0.5");
    expect(planEntryCost("1000")).toBe("0.5");
    expect(planEntryCost("10000")).toBe("5");
    expect(planEntryCost("1")).toBe("0.0005");
  });
});

describe("buildPlanComparison", () => {
  it("builds a best-case series against a flat hold line", () => {
    const plan = buildPlanComparison({
      capital: "1000",
      days: 2,
      aprPct: "36.5",
      sampleDays: 29,
      target: "3",
    });
    expect(plan.points).toEqual([
      { day: 0, sofinance: "0", hold: "0" },
      { day: 1, sofinance: "1", hold: "0" },
      { day: 2, sofinance: "2.001", hold: "0" },
    ]);
    expect(plan.endSofinance).toBe("2.001");
    expect(plan.endHold).toBe("0");
    expect(plan.vsHold).toBe("2.001");
    expect(plan.exitValue).toBe("1002.001");
    expect(plan.breakEvenDay).toBe(0);
    expect(plan.reachesTarget).toBe(false);
    expect(plan.shortfall).toBe("0.999");
    expect(plan.daysToTarget).toBe(3);
    expect(plan.sampleDays).toBe(29);
  });

  it("marks the target reached and keeps hold at zero on a 1-day plan", () => {
    const plan = buildPlanComparison({
      capital: "1000",
      days: 1,
      aprPct: "36.5",
      sampleDays: 1,
      target: "1",
    });
    expect(plan.points).toHaveLength(2);
    expect(plan.reachesTarget).toBe(true);
    expect(plan.shortfall).toBeNull();
    expect(plan.daysToTarget).toBe(1);
  });

  it("does not invent yield when the average is zero over a long horizon", () => {
    const plan = buildPlanComparison({
      capital: "5000",
      days: 365,
      aprPct: "0",
      sampleDays: 30,
      target: "10",
      entryCost: "0",
    });
    expect(plan.points).toHaveLength(366);
    expect(plan.points.every((point) => point.sofinance === "0" && point.hold === "0")).toBe(true);
    expect(plan.vsHold).toBe("0");
    expect(plan.exitValue).toBe("5000");
    expect(plan.reachesTarget).toBe(false);
    expect(plan.daysToTarget).toBeNull();
  });

  it("starts slightly negative after the protocol swap fee and breaks even on the first covering day", () => {
    const entryCost = planEntryCost("1000");
    const plan = buildPlanComparison({
      capital: "1000",
      days: 3,
      aprPct: "36.5",
      sampleDays: 29,
      target: "100",
      entryCost,
    });
    expect(entryCost).toBe("0.5");
    expect(plan.points[0]).toEqual({ day: 0, sofinance: "-0.5", hold: "0" });
    expect(Number(plan.points[1]!.sofinance)).toBeGreaterThan(0);
    expect(plan.breakEvenDay).toBe(1);
    expect(plan.exitValue).toBe(new D(1000).add(plan.endSofinance).toFixed());
  });
});
