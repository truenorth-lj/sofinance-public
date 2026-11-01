import { type Address, type Hex, numberToHex, parseAbi, type PublicClient } from "viem";
import { UNIV4_RHC } from "./constants";
import { decodePositionInfo, isRevert, poolFor } from "./exit-flow";
import { POSITION_MANAGER_READ_ABI } from "./open-abi";
import { Q96, sqrtPriceAtTick } from "./tick-math";

/**
 * What a Robinhood Chain Uniswap v4 position holds right now, read-only (no simulation, nothing signed):
 * the token amounts its liquidity is worth at the current pool price and its unclaimed (uncollected) fees,
 * from two multicalls (PositionManager reads, then StateView reads). Same numbers a full close would return
 * before slippage, so the `/app` detail panel can show Liquidity and Unclaimed fees like Solana positions.
 */
export const STATE_VIEW_POSITION_ABI = parseAbi([
  "function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
  "function getFeeGrowthInside(bytes32 poolId, int24 tickLower, int24 tickUpper) view returns (uint256 feeGrowthInside0X128, uint256 feeGrowthInside1X128)",
  "function getPositionInfo(bytes32 poolId, address owner, int24 tickLower, int24 tickUpper, bytes32 salt) view returns (uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128)",
]);

export const MAX_POSITION_VALUES = 10;
const Q128 = 1n << 128n;
const U256 = 1n << 256n;

/** Atomic token amounts as decimal strings; a field is null when its read failed (shown as a dash, never as zero). */
export type RhcPositionValue = {
  tokenId: string;
  poolId: Hex;
  amount0: string | null;
  amount1: string | null;
  fees0: string | null;
  fees1: string | null;
};

/** A value row with the USD price of one whole token0 / token1 from a public indexer (null when none reports it). */
export type RhcPositionValueRow = RhcPositionValue & { priceUsd0: number | null; priceUsd1: number | null };

/** Token amounts `liquidity` is worth at `sqrtP` (rounded down, as a withdrawal pays out). */
export function amountsForLiquidityFloor(liquidity: bigint, sqrtP: bigint, sqrtLower: bigint, sqrtUpper: bigint): { amount0: bigint; amount1: bigint } {
  const p = sqrtP < sqrtLower ? sqrtLower : sqrtP > sqrtUpper ? sqrtUpper : sqrtP;
  const amount0 = p < sqrtUpper ? (liquidity * Q96 * (sqrtUpper - p)) / sqrtUpper / p : 0n;
  const amount1 = p > sqrtLower ? (liquidity * (p - sqrtLower)) / Q96 : 0n;
  return { amount0, amount1 };
}

/** v4 Position.update: fees owed = (feeGrowthInside − last) mod 2^256 × liquidity / 2^128. */
export function unclaimedFee(liquidity: bigint, inside: bigint, last: bigint): bigint {
  return ((((inside - last) % U256) + U256) % U256) * liquidity / Q128;
}

/** PositionManager owns the PoolManager position; its salt is the token id as bytes32. */
export const positionSalt = (tokenId: bigint): Hex => numberToHex(tokenId, { size: 32 });

type Read = { tokenId: bigint; poolId: Hex; liquidity: bigint; tickLower: number; tickUpper: number };
/** viem's allowFailure multicall turns a transport failure into failed entries: rethrow it when nothing came back. */
function throwIfUnreachable(entries: readonly ({ status: "success" } | { status: "failure"; error?: unknown })[]) {
  const failed = entries.filter((e): e is { status: "failure"; error?: unknown } => e.status === "failure");
  if (entries.length && failed.length === entries.length && failed.some(e => !isRevert(e.error))) throw failed[0]!.error;
}
const ok = <T>(entry: { status: "success"; result: unknown } | { status: "failure" } | undefined) => (entry?.status === "success" ? entry.result as T : null);

/** Values for up to `MAX_POSITION_VALUES` NFT ids; ids that do not exist or are outside the allowlist are left out. */
export async function readPositionValues(client: PublicClient, tokenIds: bigint[]): Promise<RhcPositionValue[]> {
  const ids = [...new Set(tokenIds.map(String))].slice(0, MAX_POSITION_VALUES).map(BigInt);
  if (!ids.length) return [];
  const posm = UNIV4_RHC.positionManager as Address;
  const first = await client.multicall({
    allowFailure: true,
    contracts: ids.flatMap(id => [
      { address: posm, abi: POSITION_MANAGER_READ_ABI, functionName: "getPositionLiquidity", args: [id] },
      { address: posm, abi: POSITION_MANAGER_READ_ABI, functionName: "getPoolAndPositionInfo", args: [id] },
    ] as const),
  });
  throwIfUnreachable(first);
  const reads: Read[] = [];
  ids.forEach((tokenId, i) => {
    const liquidity = ok<bigint>(first[i * 2]);
    const pi = ok<readonly [{ currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address }, bigint]>(first[i * 2 + 1]);
    const pool = pi ? poolFor(pi[0]) : null;
    if (liquidity === null || !pi || !pool) return;
    const { tickLower, tickUpper } = decodePositionInfo(pi[1]);
    reads.push({ tokenId, poolId: pool.poolId as Hex, liquidity, tickLower, tickUpper });
  });
  if (!reads.length) return [];
  const pools = [...new Set(reads.map(r => r.poolId))];
  const stateView = UNIV4_RHC.stateView as Address;
  const second = await client.multicall({
    allowFailure: true,
    contracts: [
      ...pools.map(poolId => ({ address: stateView, abi: STATE_VIEW_POSITION_ABI, functionName: "getSlot0", args: [poolId] } as const)),
      ...reads.flatMap(r => [
        { address: stateView, abi: STATE_VIEW_POSITION_ABI, functionName: "getFeeGrowthInside", args: [r.poolId, r.tickLower, r.tickUpper] },
        { address: stateView, abi: STATE_VIEW_POSITION_ABI, functionName: "getPositionInfo", args: [r.poolId, posm, r.tickLower, r.tickUpper, positionSalt(r.tokenId)] },
      ] as const),
    ],
  });
  throwIfUnreachable(second);
  const sqrtOf = new Map(pools.map((poolId, i) => [poolId, ok<readonly [bigint, number, number, number]>(second[i])?.[0] ?? null]));
  return reads.map((r, i) => {
    const sqrtP = sqrtOf.get(r.poolId) ?? null;
    const amounts = sqrtP ? amountsForLiquidityFloor(r.liquidity, sqrtP, sqrtPriceAtTick(r.tickLower), sqrtPriceAtTick(r.tickUpper)) : null;
    const inside = ok<readonly [bigint, bigint]>(second[pools.length + i * 2]);
    const info = ok<readonly [bigint, bigint, bigint]>(second[pools.length + i * 2 + 1]);
    const fees = inside && info ? [unclaimedFee(info[0], inside[0], info[1]), unclaimedFee(info[0], inside[1], info[2])] : null;
    return {
      tokenId: r.tokenId.toString(), poolId: r.poolId,
      amount0: amounts ? amounts.amount0.toString() : null, amount1: amounts ? amounts.amount1.toString() : null,
      fees0: fees ? fees[0]!.toString() : null, fees1: fees ? fees[1]!.toString() : null,
    };
  });
}
