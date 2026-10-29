import { describe, expect, it } from "vitest";
import { STABLE_PAIR_HOOK, UNIV4_RHC_ALLOWLISTED_POOLS } from "./constants";
import { poolKeyOf } from "./discovery";
import { addressFromSlot, decodeHookPermissions, hookPermissionBits, isSortedPair, poolIdOf } from "./pool-key";

const SPCX = UNIV4_RHC_ALLOWLISTED_POOLS[0]!;

describe("uniswap v4 pool key", () => {
  it("recomputes the allowlisted SPCX/SPCXon pool id from its PoolKey", () => {
    expect(poolIdOf(poolKeyOf(SPCX))).toBe(SPCX.poolId);
    expect(poolIdOf({ ...poolKeyOf(SPCX), tickSpacing: 10 })).not.toBe(SPCX.poolId);
    expect(isSortedPair(SPCX.currency0.address, SPCX.currency1.address)).toBe(true);
    expect(isSortedPair(SPCX.currency1.address, SPCX.currency0.address)).toBe(false);
  });

  it("reads StablePairHook permissions from the address bits", () => {
    expect(hookPermissionBits(STABLE_PAIR_HOOK.proxy)).toBe(0x3cc0);
    expect(decodeHookPermissions(STABLE_PAIR_HOOK.proxy)).toEqual(["beforeInitialize", "afterInitialize", "beforeAddLiquidity", "afterAddLiquidity", "beforeSwap", "afterSwap"]);
  });

  it("decodes an address from a storage word", () => {
    expect(addressFromSlot(`0x000000000000000000000000${STABLE_PAIR_HOOK.implementation.slice(2).toLowerCase()}`)).toBe(STABLE_PAIR_HOOK.implementation);
    expect(addressFromSlot("0x0")).toBe("0x0000000000000000000000000000000000000000");
    expect(addressFromSlot(`0x${"f".repeat(64)}`)).toBeNull();
    expect(addressFromSlot(undefined)).toBeNull();
  });

  it("keeps the allowlist frozen", () => {
    expect(Object.isFrozen(UNIV4_RHC_ALLOWLISTED_POOLS)).toBe(true);
    expect(UNIV4_RHC_ALLOWLISTED_POOLS.map(pool => pool.baseSymbol)).toEqual(["SPCX"]);
  });
});
