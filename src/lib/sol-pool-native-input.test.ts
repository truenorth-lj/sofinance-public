import { describe, expect, it } from "vitest";
import { NATIVE_SOL_MINT } from "@sofinance/engine/ids";
import { HSOL_MINT, SOL_HSOL_CLMM_POOL_ID, USDC_MINT, USDC_USDT_CLMM_POOL_ID } from "@/lib/rwa-allowlist";
import {
  applySolPoolNativeInputPolicy,
  assertNativeSolAllowedForPool,
  assertNativeSolAllowedForPoolId,
  isNativeSolDisabledForPool,
  poolHoldsWrappedSol,
  SOL_POOL_NATIVE_INPUT_MESSAGE,
  SolPoolNativeInputError,
} from "./sol-pool-native-input";

const solHsol = { mintA: NATIVE_SOL_MINT, mintB: HSOL_MINT };
const usdcUsdt = { mintA: USDC_MINT, mintB: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB" };
const stock = { mintA: "spcxA", mintB: "spcxB" };
const sol = { kind: "native" as const, mint: NATIVE_SOL_MINT, eligible: true, reason: null };
const wsol = { kind: "token" as const, mint: NATIVE_SOL_MINT, eligible: true, reason: null };
const usdc = { kind: "token" as const, mint: USDC_MINT, eligible: true, reason: null };

describe("poolHoldsWrappedSol", () => {
  it("is true when mint A or mint B is wrapped SOL, and false otherwise", () => {
    expect(poolHoldsWrappedSol(solHsol)).toBe(true);
    expect(poolHoldsWrappedSol({ mintA: HSOL_MINT, mintB: NATIVE_SOL_MINT })).toBe(true);
    expect(poolHoldsWrappedSol(usdcUsdt)).toBe(false);
    expect(poolHoldsWrappedSol(stock)).toBe(false);
  });
});

describe("native SOL on a wrapped-SOL pool", () => {
  it("disables only native SOL and keeps token wSOL and other tokens eligible", () => {
    expect(isNativeSolDisabledForPool("native", solHsol)).toBe(true);
    expect(isNativeSolDisabledForPool("token", solHsol)).toBe(false);
    expect(isNativeSolDisabledForPool("native", stock)).toBe(false);
    const result = applySolPoolNativeInputPolicy([sol, wsol, usdc], solHsol);
    expect(result[0]).toEqual({ ...sol, eligible: false, reason: SOL_POOL_NATIVE_INPUT_MESSAGE });
    expect(result[1]).toBe(wsol);
    expect(result[2]).toBe(usdc);
    expect(applySolPoolNativeInputPolicy([sol, wsol], stock)).toEqual([sol, wsol]);
  });

  it("rejects a native-SOL selection for SOL/hSOL with the same message, and allows tokens and other pools", () => {
    expect(() => assertNativeSolAllowedForPool({ inputKind: "native" }, solHsol)).toThrow(SolPoolNativeInputError);
    expect(() => assertNativeSolAllowedForPool({ inputKind: "native" }, solHsol)).toThrow(SOL_POOL_NATIVE_INPUT_MESSAGE);
    expect(() => assertNativeSolAllowedForPool({ inputKind: "token" }, solHsol)).not.toThrow();
    expect(() => assertNativeSolAllowedForPool({ inputKind: "native" }, stock)).not.toThrow();
    expect(() => assertNativeSolAllowedForPoolId({ inputKind: "native", poolId: SOL_HSOL_CLMM_POOL_ID }))
      .toThrow(SOL_POOL_NATIVE_INPUT_MESSAGE);
    expect(() => assertNativeSolAllowedForPoolId({ inputKind: "token", poolId: SOL_HSOL_CLMM_POOL_ID })).not.toThrow();
    expect(() => assertNativeSolAllowedForPoolId({ inputKind: "native", poolId: USDC_USDT_CLMM_POOL_ID })).not.toThrow();
    expect(() => assertNativeSolAllowedForPoolId({ inputKind: "native", poolId: "unknown-pool" })).not.toThrow();
  });
});
