import { describe, expect, it } from "vitest";
import {
  ALLOWLISTED_CLMM_POOLS,
  USDC_MINT,
  USDC_USDT_CLMM_POOL_ID,
  USDT_MINT,
  allowlistedPoolById,
  isAllowlistedPoolId,
  mintsMatchAllowlist,
  missingAllowlistedPoolIds,
} from "./rwa-allowlist";

const spec = ALLOWLISTED_CLMM_POOLS[0]!;

describe("curated CLMM allowlist", () => {
  it("lists the deepest Raydium USDC/USDT CLMM pool", () => {
    expect(spec.poolAddress).toBe(USDC_USDT_CLMM_POOL_ID);
    expect(spec.mintA).toBe(USDC_MINT);
    expect(spec.mintB).toBe(USDT_MINT);
    expect(spec.wrappedSymbol).toBe("USDC");
    expect(spec.plainSymbol).toBe("USDT");
    expect(isAllowlistedPoolId(USDC_USDT_CLMM_POOL_ID)).toBe(true);
    expect(allowlistedPoolById(USDC_USDT_CLMM_POOL_ID)).toEqual(spec);
    expect(isAllowlistedPoolId("11111111111111111111111111111111")).toBe(false);
  });

  it("matches USDC/USDT mints in either order and rejects other pairs", () => {
    expect(mintsMatchAllowlist(spec, USDC_MINT, USDT_MINT)).toBe(true);
    expect(mintsMatchAllowlist(spec, USDT_MINT, USDC_MINT)).toBe(true);
    expect(mintsMatchAllowlist(spec, USDC_MINT, USDC_MINT)).toBe(false);
    expect(mintsMatchAllowlist(spec, USDC_MINT, "So11111111111111111111111111111111111111112")).toBe(false);
  });

  it("reports missing allowlisted ids", () => {
    expect(missingAllowlistedPoolIds([])).toEqual([USDC_USDT_CLMM_POOL_ID]);
    expect(missingAllowlistedPoolIds([USDC_USDT_CLMM_POOL_ID])).toEqual([]);
  });
});
