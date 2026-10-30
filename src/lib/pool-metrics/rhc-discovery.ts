import { getAddress, isAddressEqual, parseAbi, zeroAddress, type Address, type Hex, type PublicClient } from "viem";
import { STATE_VIEW_ABI } from "@sofinance/engine/protocols/uniswap-v4/abi";
import {
  DYNAMIC_FEE_FLAG, STABLE_PAIR_HOOK, UNIV4_RHC, UNIV4_RHC_ALLOWLISTED_POOLS, type Univ4AllowlistedPool,
} from "@sofinance/engine/protocols/uniswap-v4/constants";
import { isSortedPair, poolIdOf } from "@sofinance/engine/protocols/uniswap-v4/pool-key";
import { RHC_MULTICALL3, RHC_REGISTRY, rhcRegistryPairs, type RhcIssuer, type RhcRegistryFile } from "./rhc-registry";

/**
 * Cron-side discovery of Robinhood Chain same-asset pools from the token registry. State reads only, as
 * ONE Multicall3 `eth_call` (PM rule 2026-10-29: no event scans in the cron), for each registry pair:
 * - Uniswap v4: the StablePairHook pool key (dynamic fee, tick spacing 1) -> poolId -> StateView `getSlot0`;
 * - Uniswap v3: factory `getPool` at fees 100 / 500 / 3000 / 10000;
 * plus both issuer beacons' `implementation()` against the one recorded in the registry.
 * Live pools stay exactly the allowlist. A derived pool that is not allowlisted, and any v3 pool, is a
 * hidden candidate reported for review; nothing here changes what users see.
 */
export const UNIV3_RHC_FACTORY: Address = "0x1f7d7550b1b028f7571e69a784071f0205fd2efa";
export const UNIV3_FEE_TIERS = Object.freeze([100, 500, 3000, 10000] as const);
const V3_FACTORY_ABI = parseAbi(["function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)"]);
const BEACON_ABI = parseAbi(["function implementation() view returns (address)"]);

export type RhcDiscoveryCandidate =
  | { kind: "uniswap-v4"; underlying: string; poolId: Hex; currency0: Address; currency1: Address }
  | { kind: "uniswap-v3"; underlying: string; pool: Address; fee: number; token0: Address; token1: Address };

export type RhcDiscoveryResult = {
  /** Registry pairs checked. */
  pairs: number;
  /** Calls inside the single multicall, and JSON-RPC requests made (always 1). */
  calls: number;
  rpcRequests: number;
  /** Allowlisted pools the registry re-derived and found initialized. */
  allowlistedLive: number;
  /** Not shown to users; for review / adding to the allowlist. */
  candidates: RhcDiscoveryCandidate[];
  /** Allowlisted pools the registry does not derive, or derives but finds uninitialized: the registry or pool is stale. */
  allowlistedMissing: Hex[];
  /** Issuer beacons whose implementation differs from the registry file, or could not be read. */
  beaconChanges: { issuer: RhcIssuer; expected: Address; actual: Address | null }[];
  failedCalls: number;
};

type Call = { address: Address; abi: readonly unknown[]; functionName: string; args?: readonly unknown[] };

export function rhcDiscoveryCalls(file: RhcRegistryFile = RHC_REGISTRY) {
  const pairs = rhcRegistryPairs(file).map((pair) => {
    const [x, y] = [getAddress(pair.a.address), getAddress(pair.b.address)];
    const [currency0, currency1] = isSortedPair(x, y) ? [x, y] : [y, x];
    const poolId = poolIdOf({ currency0, currency1, fee: DYNAMIC_FEE_FLAG, tickSpacing: 1, hooks: STABLE_PAIR_HOOK.proxy });
    return { underlying: pair.underlying, currency0, currency1, poolId };
  });
  const calls: Call[] = [];
  for (const pair of pairs) {
    calls.push({ address: UNIV4_RHC.stateView, abi: STATE_VIEW_ABI, functionName: "getSlot0", args: [pair.poolId] });
    for (const fee of UNIV3_FEE_TIERS) calls.push({ address: UNIV3_RHC_FACTORY, abi: V3_FACTORY_ABI, functionName: "getPool", args: [pair.currency0, pair.currency1, fee] });
  }
  const issuers = Object.keys(file.beacons) as RhcIssuer[];
  for (const issuer of issuers) calls.push({ address: file.beacons[issuer].address, abi: BEACON_ABI, functionName: "implementation" });
  return { pairs, calls, issuers };
}

export async function discoverRhcRegistryPools(
  client: PublicClient,
  options: { registry?: RhcRegistryFile; allowlist?: readonly Univ4AllowlistedPool[] } = {},
): Promise<RhcDiscoveryResult> {
  const file = options.registry ?? RHC_REGISTRY, allowlist = options.allowlist ?? UNIV4_RHC_ALLOWLISTED_POOLS;
  const { pairs, calls, issuers } = rhcDiscoveryCalls(file);
  // batchSize 0: one aggregate3 eth_call however many calls (viem would otherwise chunk at 1 KB).
  const results = (await client.multicall({ contracts: calls as never, allowFailure: true, multicallAddress: RHC_MULTICALL3, batchSize: 0 })) as unknown as
    { status: "success" | "failure"; result?: unknown }[];
  const allowlisted = new Set(allowlist.map((pool) => pool.poolId.toLowerCase()));
  const derivedLive = new Set<string>();
  const candidates: RhcDiscoveryCandidate[] = [];
  let failedCalls = 0, index = 0;
  const next = () => {
    const result = results[index++]!;
    if (result.status !== "success") { failedCalls += 1; return null; }
    return result.result as unknown;
  };
  for (const pair of pairs) {
    const slot0 = next() as readonly [bigint, number, number, number] | null;
    if (slot0 && slot0[0] > 0n) {
      if (allowlisted.has(pair.poolId.toLowerCase())) derivedLive.add(pair.poolId.toLowerCase());
      else candidates.push({ kind: "uniswap-v4", underlying: pair.underlying, poolId: pair.poolId, currency0: pair.currency0, currency1: pair.currency1 });
    }
    for (const fee of UNIV3_FEE_TIERS) {
      const pool = next() as Address | null;
      if (pool && !isAddressEqual(pool, zeroAddress))
        candidates.push({ kind: "uniswap-v3", underlying: pair.underlying, pool: getAddress(pool), fee, token0: pair.currency0, token1: pair.currency1 });
    }
  }
  const beaconChanges: RhcDiscoveryResult["beaconChanges"] = [];
  for (const issuer of issuers) {
    const actual = next() as Address | null, expected = file.beacons[issuer].implementation;
    if (!actual || !isAddressEqual(actual, expected)) beaconChanges.push({ issuer, expected, actual: actual ? getAddress(actual) : null });
  }
  return {
    pairs: pairs.length,
    calls: calls.length,
    rpcRequests: 1,
    allowlistedLive: derivedLive.size,
    candidates,
    allowlistedMissing: allowlist.map((pool) => pool.poolId).filter((id) => !derivedLive.has(id.toLowerCase())),
    beaconChanges,
    failedCalls,
  };
}

/** One line for logs / Sentry; empty when everything matches the allowlist. */
export function rhcDiscoveryFindings(result: RhcDiscoveryResult): string[] {
  return [
    ...result.candidates.map((c) => c.kind === "uniswap-v4"
      ? `rhc candidate v4 ${c.underlying} ${c.poolId}` : `rhc candidate v3 ${c.underlying} fee ${c.fee} ${c.pool}`),
    ...result.allowlistedMissing.map((id) => `rhc allowlisted pool not re-derived ${id}`),
    ...result.beaconChanges.map((b) => `rhc ${b.issuer} beacon implementation ${b.actual ?? "unreadable"} (registry ${b.expected})`),
    ...(result.failedCalls ? [`rhc discovery ${result.failedCalls} failed calls`] : []),
  ];
}
