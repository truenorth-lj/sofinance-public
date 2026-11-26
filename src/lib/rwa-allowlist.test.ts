import { describe, expect, it } from "vitest";
import {
  ALLOWLISTED_CLMM_POOLS,
  CBBTC_MINT,
  CBBTC_WBTC_CLMM_POOL_ID,
  HSOL_MINT,
  NATIVE_SOL_MINT,
  SOL_HSOL_CLMM_POOL_ID,
  USDC_MINT,
  USDC_USDT_CLMM_POOL_ID,
  USDT_MINT,
  WBTC_PORTAL_MINT,
  allowlistedPoolById,
  isAllowlistedPoolId,
  missingAllowlistedPoolIds,
  mintsMatchAllowlist,
} from "./rwa-allowlist";

const usdcUsdt = ALLOWLISTED_CLMM_POOLS.find((spec) => spec.poolAddress === USDC_USDT_CLMM_POOL_ID)!;
const solHsol = ALLOWLISTED_CLMM_POOLS.find((spec) => spec.poolAddress === SOL_HSOL_CLMM_POOL_ID)!;
const cbbtcWbtc = ALLOWLISTED_CLMM_POOLS.find((spec) => spec.poolAddress === CBBTC_WBTC_CLMM_POOL_ID)!;

describe("curated CLMM allowlist", () => {
  it("lists the deepest Raydium USDC/USDT CLMM pool as a stable pair", () => {
    expect(usdcUsdt).toMatchObject({
      poolAddress: USDC_USDT_CLMM_POOL_ID,
      mintA: USDC_MINT,
      mintB: USDT_MINT,
      wrappedSymbol: "USDC",
      plainSymbol: "USDT",
      wrapKind: "stable",
    });
    expect(isAllowlistedPoolId(USDC_USDT_CLMM_POOL_ID)).toBe(true);
    expect(allowlistedPoolById(USDC_USDT_CLMM_POOL_ID)).toEqual(usdcUsdt);
    expect(isAllowlistedPoolId("11111111111111111111111111111111")).toBe(false);
  });

  it("lists the Raydium SOL/hSOL CLMM pool as an LST pair with SOL first, not WSOL", () => {
    expect(solHsol).toMatchObject({
      poolAddress: SOL_HSOL_CLMM_POOL_ID,
      mintA: NATIVE_SOL_MINT,
      mintB: HSOL_MINT,
      baseSymbol: "SOL",
      wrappedSymbol: "SOL",
      plainSymbol: "hSOL",
      wrapKind: "lst",
    });
    expect(isAllowlistedPoolId(SOL_HSOL_CLMM_POOL_ID)).toBe(true);
    expect(allowlistedPoolById(SOL_HSOL_CLMM_POOL_ID)).toEqual(solHsol);
  });

  it("lists the Raydium cbBTC/WBTC CLMM pool as a same-asset pair on the Coinbase and Wormhole (Portal) mints", () => {
    expect(CBBTC_WBTC_CLMM_POOL_ID).toBe("8GuXrPq6deS1ZzNXYmBjVZ5P48cAmKGrhhpdAn2FURPC");
    expect(CBBTC_MINT).toBe("cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij");
    expect(WBTC_PORTAL_MINT).toBe("3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh");
    expect(cbbtcWbtc).toEqual({
      poolAddress: CBBTC_WBTC_CLMM_POOL_ID,
      mintA: CBBTC_MINT,
      mintB: WBTC_PORTAL_MINT,
      baseSymbol: "BTC",
      wrappedSymbol: "cbBTC",
      plainSymbol: "WBTC",
      wrapKind: "same-asset",
    });
    expect(isAllowlistedPoolId(CBBTC_WBTC_CLMM_POOL_ID)).toBe(true);
    expect(mintsMatchAllowlist(cbbtcWbtc, CBBTC_MINT, WBTC_PORTAL_MINT)).toBe(true);
    expect(mintsMatchAllowlist(cbbtcWbtc, WBTC_PORTAL_MINT, CBBTC_MINT)).toBe(true);
    // BitGo's native WBTC mint is a different token: not this pair.
    expect(mintsMatchAllowlist(cbbtcWbtc, CBBTC_MINT, "5XZw2LKTyrfvfiskJ78AMpackRjPcyCif1WhUsPDuVqQ")).toBe(false);
  });

  it("matches allowlisted mints in either order and rejects other pairs", () => {
    expect(mintsMatchAllowlist(usdcUsdt, USDC_MINT, USDT_MINT)).toBe(true);
    expect(mintsMatchAllowlist(usdcUsdt, USDT_MINT, USDC_MINT)).toBe(true);
    expect(mintsMatchAllowlist(usdcUsdt, USDC_MINT, USDC_MINT)).toBe(false);
    expect(mintsMatchAllowlist(usdcUsdt, USDC_MINT, NATIVE_SOL_MINT)).toBe(false);
    expect(mintsMatchAllowlist(solHsol, NATIVE_SOL_MINT, HSOL_MINT)).toBe(true);
    expect(mintsMatchAllowlist(solHsol, HSOL_MINT, NATIVE_SOL_MINT)).toBe(true);
  });

  it("reports missing allowlisted ids", () => {
    expect(missingAllowlistedPoolIds([])).toEqual([USDC_USDT_CLMM_POOL_ID, SOL_HSOL_CLMM_POOL_ID, CBBTC_WBTC_CLMM_POOL_ID]);
    expect(missingAllowlistedPoolIds([USDC_USDT_CLMM_POOL_ID])).toEqual([SOL_HSOL_CLMM_POOL_ID, CBBTC_WBTC_CLMM_POOL_ID]);
    expect(missingAllowlistedPoolIds([USDC_USDT_CLMM_POOL_ID, SOL_HSOL_CLMM_POOL_ID, CBBTC_WBTC_CLMM_POOL_ID])).toEqual([]);
  });
});
