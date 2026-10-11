import { describe, expect, it } from "vitest";
import {
  applyPlanChange,
  DEFAULT_PLAN_LOSS_ALERT,
  DEFAULT_PLAN_LOSS_ALERT_PCT,
  DEFAULT_PLAN_SETUP,
  parsePlanSetup,
  percentOfAmount,
  shareOfAmount,
  type PlanSetup,
} from "./lp-plan-intent";

const base: PlanSetup = {
  days: 30,
  amount: "1000",
  lossAlert: DEFAULT_PLAN_LOSS_ALERT,
  exitAsset: "usdc",
};

describe("shareOfAmount", () => {
  it("uses 5% as the default loss alert on 1,000 USDC", () => {
    expect(shareOfAmount("1000", DEFAULT_PLAN_LOSS_ALERT_PCT)).toBe("50");
    expect(shareOfAmount("0.001", 5)).toBe("0.00005");
    expect(shareOfAmount("0.000001", 1)).toBe("0.000001");
  });
});

describe("applyPlanChange", () => {
  it("rescales the loss alert when amount goes 1 → 10,000 so it does not stick at $1", () => {
    const down = applyPlanChange(base, { amount: "1" });
    expect(down.amount).toBe("1");
    expect(down.lossAlert).toBe("0.05");
    expect(percentOfAmount(down.lossAlert, down.amount)).toBeCloseTo(DEFAULT_PLAN_LOSS_ALERT_PCT);

    const up = applyPlanChange(down, { amount: "10000" });
    expect(up.amount).toBe("10000");
    expect(up.lossAlert).toBe("500");
    expect(up.lossAlert).not.toBe("1");
  });

  it("keeps an explicit loss-alert edit and only clamps it to the amount", () => {
    expect(applyPlanChange(base, { amount: "20", lossAlert: "50" }).lossAlert).toBe("20");
  });

  it("changes days without touching the amount or alert", () => {
    expect(applyPlanChange(base, { days: 45 })).toEqual({ ...base, days: 45 });
  });
});

describe("parsePlanSetup", () => {
  const parse = (query: string) => parsePlanSetup(new URLSearchParams(query));

  it("defaults to 1,000 USDC for 30 days with a 5% alert and a USDC exit", () => {
    expect(parse("")).toEqual(DEFAULT_PLAN_SETUP);
    expect(DEFAULT_PLAN_SETUP).toEqual(base);
  });

  it("reads amount, days, alert and exit", () => {
    expect(parse("amount=5,000&days=45&alert=100&exit=tokens")).toEqual({
      days: 45,
      amount: "5000",
      lossAlert: "100",
      exitAsset: "tokens",
    });
  });

  it("ignores the retired goal-first params instead of crashing", () => {
    expect(parse("goal=beat-holding&target=100&aim=250&edit=target")).toEqual(DEFAULT_PLAN_SETUP);
    expect(parse("amount=2000&target=999999&goal=nonsense")).toEqual({
      ...DEFAULT_PLAN_SETUP,
      amount: "2000",
      lossAlert: "100",
    });
  });

  it("falls back to defaults for invalid values", () => {
    expect(parse("amount=abc&days=0&alert=-1&exit=weird")).toEqual(DEFAULT_PLAN_SETUP);
    expect(parse("days=400").days).toBe(30);
    expect(parse("amount=100&alert=500").lossAlert).toBe("5");
  });
});
