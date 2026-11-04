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

  it("Meteora: 10 bps on the swapped deposit, 0.0419 SOL rent stated not subtracted, pool tokens only", () => {
    const terms = planPoolTerms({ descriptor: meteoraDlmmDescriptor, listOpenReason: null, symbols: ["TSLAx", "TSLA"] });
    expect(terms.openCost.bps).toBe(10);
    expect(planEntryCost("1000", terms.openCost.bps)).toBe("1");
    expect(terms.openCost.rowLabel).toBe("0.1% platform fee on the swap");
    expect(terms.openCost.rowNote).toBe("Plus about 0.0419 SOL position rent, refunded on full close");
    expect(terms.openCost.chart).toBe("Opening costs the 0.1% platform fee on the swapped part (all of a USDC deposit), and Day 0 subtracts that from the deposit. About 0.0419 SOL of position rent is set aside on top and refunded when you fully withdraw, so it is not subtracted. Network fees and swap price impact are ignored.");
    expect(terms.exits).toEqual(["tokens"]);
    expect(terms.tokensExitLabel).toBe("TSLAx and TSLA, the pool tokens");
    expect(terms.open).toEqual({ supported: true });
    expect(effectiveExit("usdc", terms.exits)).toBe("tokens");
  });

  it("the descriptor's open capability wins over the list; a fee-free DEX costs nothing on day 0", () => {
    const closed: DexDescriptor = {
      ...meteoraDlmmDescriptor,
      meta: { ...meteoraDlmmDescriptor.meta, rent: null, feePolicy: { ...meteoraDlmmDescriptor.meta.feePolicy, open: { kind: "none" } } },
      capabilities: { ...meteoraDlmmDescriptor.capabilities, open: { supported: false, reason: "Not here yet." },
        withdrawOutputs: ["pool-tokens", "usdc"] },
    };
    const terms = planPoolTerms({ descriptor: closed, listOpenReason: null });
    expect(terms.open).toEqual({ supported: false, reason: "Not here yet." });
    expect(terms.openCost.bps).toBe(0);
    expect(terms.openCost.rowNote).toBeNull();
    expect(terms.exits).toEqual(["usdc", "tokens"]);
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
    expect(terms.exitCost.usdc).toEqual({ bps: 10, label: "0.1% platform fee to swap back to USDC" });
    expect(terms.exitCost.tokens).toEqual({ bps: 0, label: "no platform fee to take the pool tokens" });
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
