import { describe, expect, it } from "vitest";
import type { UnifiedPool } from "./model";
import { poolPlanCapability, poolSupportsCalculator } from "./plan-support";

const pool = (protocol: UnifiedPool["protocol"]): Pick<UnifiedPool, "protocol"> => ({ protocol });

describe("poolSupportsCalculator", () => {
  it("is true for Raydium and Meteora (the same pools whose cards show Calculate)", () => {
    expect(poolSupportsCalculator(pool("raydium-clmm"))).toBe(true);
    expect(poolPlanCapability(pool("raydium-clmm"))).toEqual({ supported: true });
    expect(poolSupportsCalculator(pool("meteora-dlmm"))).toBe(true);
  });

  it("is false for Robinhood Chain (no planFallback; cards hide Calculate)", () => {
    expect(poolPlanCapability(pool("uniswap-v4-rhc"))).toBeNull();
    expect(poolSupportsCalculator(pool("uniswap-v4-rhc"))).toBe(false);
  });

  it("is false for Orca (plan is registered but unsupported; the card greys the control)", () => {
    const plan = poolPlanCapability(pool("orca-whirlpool"));
    expect(plan?.supported).toBe(false);
    expect(poolSupportsCalculator(pool("orca-whirlpool"))).toBe(false);
  });
});
