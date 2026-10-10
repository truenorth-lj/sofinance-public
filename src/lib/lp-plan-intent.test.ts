import { describe, expect, it } from "vitest";
import type { Intent } from "./lp-intent";
import {
  applyIntentChange,
  DEFAULT_PLAN_LOSS_ALERT,
  DEFAULT_PLAN_LOSS_ALERT_PCT,
  DEFAULT_PLAN_TARGET_PCT,
  percentOfAmount,
  shareOfAmount,
} from "./lp-plan-intent";

const base: Intent = {
  days: 30,
  amount: "1000",
  goal: "net-by-date",
  target: "100",
  lossAlert: DEFAULT_PLAN_LOSS_ALERT,
  exitAsset: "usdc",
};

describe("shareOfAmount", () => {
  it("uses 10% as the default aim on 1,000 USDC", () => {
    expect(shareOfAmount("1000", DEFAULT_PLAN_TARGET_PCT)).toBe("100");
    expect(shareOfAmount("1000", DEFAULT_PLAN_LOSS_ALERT_PCT)).toBe("50");
  });
});

describe("applyIntentChange", () => {
  it("rescales the loss alert when amount goes 1 → 10,000 so it does not stick at $1", () => {
    const down = applyIntentChange(base, { amount: "1" });
    expect(down.amount).toBe("1");
    expect(down.lossAlert).toBe("0.05");
    expect(down.target).toBe("0.1");
    expect(percentOfAmount(down.lossAlert, down.amount)).toBeCloseTo(DEFAULT_PLAN_LOSS_ALERT_PCT);

    const up = applyIntentChange(down, { amount: "10000" });
    expect(up.amount).toBe("10000");
    expect(up.lossAlert).toBe("500");
    expect(up.target).toBe("1000");
    expect(up.lossAlert).not.toBe("1");
  });

  it("keeps an explicit loss-alert edit and only clamps it to the amount", () => {
    const next = applyIntentChange(base, { amount: "20", lossAlert: "50" });
    expect(next.lossAlert).toBe("20");
    expect(next.target).toBe("2");
  });
});
