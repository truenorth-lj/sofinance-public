import { encodeAbiParameters, getAddress, keccak256, type Address, type Hex } from "viem";

export type PoolKey = { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address };

const POOL_KEY_ABI = [{
  type: "tuple",
  components: [
    { name: "currency0", type: "address" },
    { name: "currency1", type: "address" },
    { name: "fee", type: "uint24" },
    { name: "tickSpacing", type: "int24" },
    { name: "hooks", type: "address" },
  ],
}] as const;

/** PoolId = keccak256(abi.encode(PoolKey)) (v4-core `PoolIdLibrary.toId`). */
export function poolIdOf(key: PoolKey): Hex {
  return keccak256(encodeAbiParameters(POOL_KEY_ABI, [{ ...key, currency0: getAddress(key.currency0), currency1: getAddress(key.currency1), hooks: getAddress(key.hooks) }]));
}

/** v4 requires currency0 < currency1 (numerically). */
export function isSortedPair(currency0: Address, currency1: Address): boolean {
  return BigInt(currency0) < BigInt(currency1);
}

export const HOOK_PERMISSION_FLAGS = Object.freeze({
  beforeInitialize: 1 << 13,
  afterInitialize: 1 << 12,
  beforeAddLiquidity: 1 << 11,
  afterAddLiquidity: 1 << 10,
  beforeRemoveLiquidity: 1 << 9,
  afterRemoveLiquidity: 1 << 8,
  beforeSwap: 1 << 7,
  afterSwap: 1 << 6,
  beforeDonate: 1 << 5,
  afterDonate: 1 << 4,
  beforeSwapReturnDelta: 1 << 3,
  afterSwapReturnDelta: 1 << 2,
  afterAddLiquidityReturnDelta: 1 << 1,
  afterRemoveLiquidityReturnDelta: 1 << 0,
});
export type HookPermission = keyof typeof HOOK_PERMISSION_FLAGS;

/** v4 hook permissions are the low 14 bits of the hook address. */
export function hookPermissionBits(hook: Address): number {
  return Number(BigInt(hook) & 0x3fffn);
}

export function decodeHookPermissions(hook: Address): HookPermission[] {
  const bits = hookPermissionBits(hook);
  return (Object.entries(HOOK_PERMISSION_FLAGS) as [HookPermission, number][]).filter(([, flag]) => (bits & flag) !== 0).map(([name]) => name);
}

/** Address stored in a 32-byte storage word (e.g. the ERC1967 implementation slot). */
export function addressFromSlot(word: Hex | undefined | null): Address | null {
  if (!word || !/^0x[0-9a-fA-F]{1,64}$/.test(word)) return null;
  const value = BigInt(word);
  if (value >> 160n !== 0n) return null;
  return getAddress(`0x${value.toString(16).padStart(40, "0")}`);
}
