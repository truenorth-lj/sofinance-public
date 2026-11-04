import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import { selectBestPlanApr, trailingWindowAverage } from "./lp-plan-best-apr";
import { planDataNotice } from "./lp-plan-notice";
import { LEGACY_PLAN_TERMS, projectPoolPlan } from "./lp-plan-pool-terms";
import { cappedGrowthPath } from "./lp-plan-yield";
import { AMZN_LAUNCH_POINTS, AMZN_LAUNCH_TVL_USD as AMZN_TVL_USD } from "./amzn-launch-daily-apr.fixture";

const DAY = 86_400;
const OCT_29 = 1_793_232_000;
const money = (value: string) => new Decimal(value).toFixed(2);

describe("AMZNx/AMZN launch spike (prod bug, 2026-11-04)", () => {
  const best = selectBestPlanApr(AMZN_LAUNCH_POINTS)!;

  it("averages four days to 801% and picks the 90-day window, but only ~$25 of fees stand behind it", () => {
    expect(best.windowDays).toBe(90);
    expect(best.sampleDays).toBe(4);
    expect(Number(best.aprPct)).toBeCloseTo(801.0573, 4);
    // $8,397 + $1,615 + $58 + $9 of volume × 0.25% ≈ $25.20 over four days.
    expect(Number(best.poolFeesPerDayUsd)).toBeCloseTo(6.2989, 4);
  });

  it("without the cap reproduces the dialog: 78,551.2% APY, $785,512 of fees, −$7,865 to close, Break-even day 2", () => {
    const uncappedWindow = { aprPct: best.aprPct, sampleDays: best.sampleDays, windowDays: best.windowDays };
    const plan = projectPoolPlan({ capital: "1000", days: 365, window: uncappedWindow, terms: LEGACY_PLAN_TERMS, exit: "usdc" });
    expect(new Decimal(plan.apyPct).toFixed(1)).toBe("78551.2");
    expect(money(plan.feesEarned)).toBe("785512.33");
    // The closing cost is 1% of the inflated end value, so it inflates with it.
    expect(money(plan.exitCost)).toBe("7865.02");
    expect(plan.breakEvenDay).toBe(2);
    expect(plan.feeCapped).toBe(false);
  });

  it("with the cap never collects more than the pool's LPs took per day, split with the $1,238 already in the pool", () => {
    const plan = projectPoolPlan({ capital: "1000", days: 365, window: best, terms: LEGACY_PLAN_TERMS, exit: "usdc", poolTvlUsd: AMZN_TVL_USD });
    expect(plan.feeCapped).toBe(true);
    expect(money(plan.feesEarned)).toBe("1044.71");
    expect(new Decimal(plan.apyPct).toFixed(2)).toBe("104.47");
    expect(money(plan.exitCost)).toBe("20.35");
    expect(plan.breakEvenDay).toBe(9);
    // Hard bound: a whole year of the pool's own LP fees ($6.30 × 84% a day) is more than the projection collects.
    const poolLpFeesPerYear = new Decimal(best.poolFeesPerDayUsd!).mul(LEGACY_PLAN_TERMS.lpFeeShare).mul(365);
    expect(new Decimal(plan.feesEarned).lt(poolLpFeesPerYear)).toBe(true);
  });

  it("the calculator hides these numbers: four days is too few to project from", () => {
    expect(planDataNotice({ sampleDays: best.sampleDays, poolTvlUsd: AMZN_TVL_USD })).toEqual({
      kind: "hide",
      message: "Only 4 days of trading data for this pool, too few to project fees from, so no numbers are shown. Check back once it has 7 days.",
    });
  });
});

describe("cappedGrowthPath", () => {
  it("takes, each day, the smaller of the APR and the pool's fees × your share of the pool after your deposit", () => {
    const rate = new Decimal(36.5).div(100).div(365); // 0.1% a day
    // Pool LPs take $10 a day on $10,000: a $1,000 deposit gets 1,000 / 11,000 of it, $0.909, not $1.
    const { values, cappedFromDay } = cappedGrowthPath("1000", rate, 1, { poolLpFeesPerDayUsd: "10", poolTvlUsd: "10000" });
    expect(values[1]!.sub(1000).toFixed(4)).toBe("0.9091");
    expect(cappedFromDay).toBe(1);
    // A huge pool barely dilutes and a lower APR binds instead.
    const big = cappedGrowthPath("1000", rate, 1, { poolLpFeesPerDayUsd: "1000000", poolTvlUsd: "1000000" });
    expect(big.values[1]!.sub(1000).toFixed(4)).toBe("1.0000");
    expect(big.cappedFromDay).toBeNull();
  });
});

describe("trailingWindowAverage pool fees", () => {
  it("is left out when a finite day has no TVL, so nothing is capped on made-up numbers", () => {
    const points = [{ time: OCT_29, aprPct: 100 }, { time: OCT_29 + DAY, aprPct: 50, tvlUsd: 1000 }];
    expect(trailingWindowAverage(points, 7)).toEqual({ windowDays: 7, aprPct: "75", sampleDays: 2 });
  });
});

describe("planDataNotice", () => {
  it("warns on a pool under $5k with enough days, and says nothing for a bigger one", () => {
    expect(planDataNotice({ sampleDays: 12, poolTvlUsd: 1238.25 })).toEqual({
      kind: "warn",
      message: "Small pool: about $1,238 in it. These numbers are capped at the fees this pool actually paid, shared with your deposit. With so little in the pool, a few trades can swing them a lot.",
    });
    expect(planDataNotice({ sampleDays: 12, poolTvlUsd: 5_000 })).toBeNull();
    expect(planDataNotice({ sampleDays: 7, poolTvlUsd: null })).toBeNull();
    expect(planDataNotice({ sampleDays: 1, poolTvlUsd: 1e9 })?.message).toMatch(/^Only 1 day of trading data/);
  });
});
