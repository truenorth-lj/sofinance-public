import { describe, expect, it } from "vitest";
import { meteoraDlmmDescriptor } from "./dex/meteora-dlmm/descriptor";
import type { DexDescriptor } from "./dex/types";
import { effectiveExit, LEGACY_PLAN_TERMS, planPoolTerms, projectPoolPlan } from "./lp-plan-pool-terms";
import { planEntryCost } from "./lp-plan-yield";

describe("planPoolTerms", () => {
  it("no descriptor keeps the original ~1% assumption, both exits and the list's open rule", () => {
    expect(LEGACY_PLAN_TERMS.openCost.bps).toBe(100);
    expect(LEGACY_PLAN_TERMS.openCost.rowLabel).toBe("about 1%");
    expect(LEGACY_PLAN_TERMS.exits).toEqual(["usdc", "tokens"]);
    expect(LEGACY_PLAN_TERMS.open).toEqual({ supported: true });
    expect(planPoolTerms({ descriptor: null, listOpenReason: "No" }).open).toEqual({ supported: false, reason: "No" });
  });

  it("Meteora: the shared 1% swap estimate plus 10 bps on the swapped deposit, 0.0419 SOL rent stated not subtracted, pool tokens only", () => {
    const terms = planPoolTerms({ descriptor: meteoraDlmmDescriptor, listOpenReason: null, symbols: ["TSLAx", "TSLA"] });
    expect(terms.openCost.bps).toBe(110);
    expect(planEntryCost("1000", terms.openCost.bps)).toBe("11");
    expect(terms.openCost.rowLabel).toBe("about 1% swap cost plus the 0.1% platform fee");
    expect(terms.openCost.rowNote).toBe("Plus about 0.0419 SOL position rent, refunded on full close");
    expect(terms.openCost.chart).toBe("Opening costs about 1% to swap the deposit into the pool tokens plus the 0.1% platform fee on the swapped part (all of a USDC deposit), and Day 0 subtracts that from the deposit. About 0.0419 SOL of position rent is set aside on top and refunded when you fully withdraw, so it is not subtracted. Network fees are ignored.");
    expect(terms.exits).toEqual(["tokens"]);
    expect(terms.tokensExitLabel).toBe("TSLAx and TSLA, the pool tokens");
    expect(terms.open).toEqual({ supported: true });
    expect(effectiveExit("usdc", terms.exits)).toBe("tokens");
  });

  it("the descriptor's open capability wins over the list; a fee-free DEX still pays the shared swap estimate on day 0", () => {
    const closed: DexDescriptor = {
      ...meteoraDlmmDescriptor,
      meta: { ...meteoraDlmmDescriptor.meta, rent: null, feePolicy: { ...meteoraDlmmDescriptor.meta.feePolicy, open: { kind: "none" } } },
      capabilities: { ...meteoraDlmmDescriptor.capabilities, open: { supported: false, reason: "Not here yet." },
        withdrawOutputs: ["pool-tokens", "usdc"] },
    };
    const terms = planPoolTerms({ descriptor: closed, listOpenReason: null });
    expect(terms.open).toEqual({ supported: false, reason: "Not here yet." });
    expect(terms.openCost.bps).toBe(100);
    expect(terms.openCost.rowLabel).toBe("about 1% swap cost, no platform fee");
    expect(terms.openCost.rowNote).toBeNull();
    expect(terms.exits).toEqual(["usdc", "tokens"]);
  });

  it("useDescriptorPlanTerms false keeps legacy terms even when a descriptor is passed; omitted flag stays as today", () => {
    const forcedLegacy = planPoolTerms({ descriptor: meteoraDlmmDescriptor, useDescriptorPlanTerms: false, listOpenReason: null });
    expect(forcedLegacy.openCost.bps).toBe(LEGACY_PLAN_TERMS.openCost.bps);
    expect(forcedLegacy.lpFeeShare).toBe(LEGACY_PLAN_TERMS.lpFeeShare);
    expect(forcedLegacy.exits).toEqual(LEGACY_PLAN_TERMS.exits);
    expect(planPoolTerms({ descriptor: meteoraDlmmDescriptor, listOpenReason: null }).openCost.bps).toBe(110);
    expect(planPoolTerms({ descriptor: null, useDescriptorPlanTerms: true, listOpenReason: null }).openCost.bps).toBe(LEGACY_PLAN_TERMS.openCost.bps);
  });
});

describe("LP share and closing cost", () => {
  it("Raydium pools keep 84% of the pool fee after the usual 16% cut; closing to USDC is assumed at about 1%", () => {
    expect(LEGACY_PLAN_TERMS.lpFeeShare).toBeCloseTo(0.84, 12);
    expect(LEGACY_PLAN_TERMS.lpShareLabel).toBe("after Raydium's 16% cut");
    expect(LEGACY_PLAN_TERMS.exitCost.usdc).toEqual({ bps: 100, label: "about 1% to swap back to USDC" });
    expect(LEGACY_PLAN_TERMS.exitCost.tokens).toEqual({ bps: 0, label: "no swap when you take the pool tokens" });
  });

  it("a registered DEX takes its LP share and closing fees from its descriptor", () => {
    const terms = planPoolTerms({ descriptor: meteoraDlmmDescriptor, listOpenReason: null });
    expect(terms.lpFeeShare).toBe(0.9);
    expect(terms.lpShareLabel).toBe("after Meteora's 10% cut");
    // Close to USDC: the shared 1% swap-cost estimate (same as Raydium's) plus Meteora's 0.1% platform fee.
    expect(terms.exitCost.usdc).toEqual({ bps: 110, label: "about 1% to swap back to USDC plus the 0.1% platform fee" });
    expect(terms.exitCost.tokens).toEqual({ bps: 0, label: "no platform fee to take the pool tokens" });
  });

  it("Meteora's open and close each cost the shared swap estimate plus its platform fee ($1,000, 1Y, 10% pool APR)", () => {
    const terms = planPoolTerms({ descriptor: meteoraDlmmDescriptor, listOpenReason: null });
    const window = { aprPct: "10", sampleDays: 90, windowDays: 90 };
    const plan = projectPoolPlan({ capital: "1000", days: 365, window, terms, exit: "usdc" });
    // 10% x 0.9 LP share = 9% APR -> 9.4162% APY; open 1.1% = $11.00; value before close $1,083.16.
    expect(Number(plan.aprPct)).toBeCloseTo(9, 9);
    expect(Number(plan.entryCost)).toBeCloseTo(11, 9); // was $1.00 with the platform fee alone
    expect(plan.exitCostBps).toBe(110);
    expect(Number(plan.exitCost)).toBeCloseTo(11.91, 2); // 1.1% of $1,083.16 (was $12.02)
    expect(Number(plan.vsHold)).toBeCloseTo(71.25, 2); // was +$81.14
    expect(plan.breakEvenDay).toBe(89); // was day 49
    const tokens = projectPoolPlan({ capital: "1000", days: 365, window, terms, exit: "tokens" });
    expect(Number(tokens.vsHold)).toBeCloseTo(83.16, 2); // was +$93.16
    expect(tokens.breakEvenDay).toBe(45);
  });

  it("projects with the LP share of the APR and the chosen exit's closing cost", () => {
    const window = { aprPct: "36.5", sampleDays: 30, windowDays: 30 };
    const usdc = projectPoolPlan({ capital: "1000", days: 365, window, terms: LEGACY_PLAN_TERMS, exit: "usdc" });
    const tokens = projectPoolPlan({ capital: "1000", days: 365, window, terms: LEGACY_PLAN_TERMS, exit: "tokens" });
    expect(Number(usdc.aprPct)).toBeCloseTo(30.66, 9);
    expect(usdc.exitCostBps).toBe(100);
    expect(tokens.exitCostBps).toBe(0);
    // Same fees either way; the USDC exit pays 1% of the closing value on top.
    expect(usdc.feesEarned).toBe(tokens.feesEarned);
    expect(Number(tokens.endSofinance) - Number(usdc.endSofinance)).toBeCloseTo(Number(usdc.exitCost), 9);
    expect(Number(usdc.exitValue)).toBeCloseTo(1335.14, 2);
    expect(usdc.breakEvenDay).toBe(24);
    expect(tokens.breakEvenDay).toBeLessThan(24);
  });
});
