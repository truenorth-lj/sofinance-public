import { getAddress, zeroAddress, type Address } from "viem";
import { describe, expect, it } from "vitest";
import { UNIV4_RHC_ALLOWLISTED_POOLS } from "@sofinance/engine/protocols/uniswap-v4/constants";
import { discoverRhcRegistryPools, rhcDiscoveryCalls, rhcDiscoveryFindings, UNIV3_FEE_TIERS } from "./rhc-discovery";
import { RHC_ISSUER_BEACONS, RHC_REGISTRY, rhcRegistryPairs } from "./rhc-registry";

type Contract = { address: Address; functionName: string; args?: readonly unknown[] };
const V3_HIT = getAddress("0x00000000000000000000000000000000000000aa");

/** Multicall stand-in: answers from the registry's own state, records how it was called. */
function mockClient(over: { live?: (poolId: string) => boolean; v3?: (fee: number) => Address; implementation?: (beacon: Address) => Address | null } = {}) {
  const requests: { count: number; batchSize?: number; multicallAddress?: Address } = { count: 0 };
  const allowlisted = new Set(UNIV4_RHC_ALLOWLISTED_POOLS.map((pool) => pool.poolId.toLowerCase()));
  const client = {
    multicall: async (args: { contracts: Contract[]; batchSize?: number; multicallAddress?: Address }) => {
      requests.count += 1;
      requests.batchSize = args.batchSize;
      requests.multicallAddress = args.multicallAddress;
      return args.contracts.map((call) => {
        if (call.functionName === "getSlot0") {
          const live = (over.live ?? ((id) => allowlisted.has(id)))(String(call.args![0]).toLowerCase());
          return { status: "success", result: [live ? 79228162514264337593543950336n : 0n, 0, 0, 0] };
        }
        if (call.functionName === "getPool") return { status: "success", result: over.v3?.(Number(call.args![2])) ?? zeroAddress };
        const issuer = (Object.keys(RHC_REGISTRY.beacons) as (keyof typeof RHC_REGISTRY.beacons)[])
          .find((key) => RHC_REGISTRY.beacons[key].address === call.address)!;
        const actual = over.implementation ? over.implementation(call.address) : RHC_REGISTRY.beacons[issuer].implementation;
        return actual ? { status: "success", result: actual } : { status: "failure", error: new Error("revert") };
      });
    },
  };
  return { client: client as never, requests };
}

describe("rhc-tokens.json (checked-in registry)", () => {
  it("pairs one Robinhood and one Ondo token per underlying, every token beacon-verified", () => {
    const pairs = rhcRegistryPairs();
    expect(pairs.length).toBeGreaterThan(0);
    for (const pair of pairs) {
      expect(new Set([pair.a.issuer, pair.b.issuer])).toEqual(new Set(["robinhood", "ondo"]));
      expect(pair.a.underlying).toBe(pair.b.underlying);
    }
    for (const token of RHC_REGISTRY.tokens) {
      expect(token.chain).toBe("robinhood");
      expect(token.verification).toEqual({ method: "issuer-beacon", beacon: RHC_ISSUER_BEACONS[token.issuer] });
      expect(getAddress(token.address)).toBe(token.address);
    }
    expect(new Set(RHC_REGISTRY.tokens.map((token) => token.address.toLowerCase())).size).toBe(RHC_REGISTRY.tokens.length);
  });

  it("derives every allowlisted pool from a registry pair", () => {
    const derived = new Set(rhcDiscoveryCalls().pairs.map((pair) => pair.poolId.toLowerCase()));
    for (const pool of UNIV4_RHC_ALLOWLISTED_POOLS) expect(derived.has(pool.poolId.toLowerCase())).toBe(true);
  });
});

describe("discoverRhcRegistryPools (state reads, one multicall)", () => {
  it("makes exactly one multicall request: slot0 + 4 v3 fee tiers per pair, plus both beacons", async () => {
    const { client, requests } = mockClient();
    const result = await discoverRhcRegistryPools(client);
    const pairs = rhcRegistryPairs().length;
    expect(requests).toMatchObject({ count: 1, batchSize: 0 });
    expect(result).toMatchObject({ pairs, calls: pairs * (1 + UNIV3_FEE_TIERS.length) + 2, rpcRequests: 1 });
    expect(result.allowlistedLive).toBe(UNIV4_RHC_ALLOWLISTED_POOLS.length);
    expect(result.candidates).toEqual([]);
    expect(result.allowlistedMissing).toEqual([]);
    expect(result.beaconChanges).toEqual([]);
    expect(rhcDiscoveryFindings(result)).toEqual([]);
  });

  it("reports a live non-allowlisted v4 pool and any v3 pool as hidden candidates only", async () => {
    const extra = rhcDiscoveryCalls().pairs.find((pair) =>
      !UNIV4_RHC_ALLOWLISTED_POOLS.some((pool) => pool.poolId.toLowerCase() === pair.poolId.toLowerCase()))!;
    expect(extra).toBeDefined();
    const { client } = mockClient({ live: () => true, v3: (fee) => (fee === 500 ? V3_HIT : zeroAddress) });
    const result = await discoverRhcRegistryPools(client);
    expect(result.allowlistedLive).toBe(UNIV4_RHC_ALLOWLISTED_POOLS.length);
    expect(result.candidates.filter((c) => c.kind === "uniswap-v4")).toEqual([expect.objectContaining({ poolId: extra.poolId, underlying: extra.underlying })]);
    const v3 = result.candidates.filter((c) => c.kind === "uniswap-v3");
    expect(v3).toHaveLength(rhcRegistryPairs().length);
    expect(v3.every((c) => c.kind === "uniswap-v3" && c.fee === 500 && c.pool === V3_HIT)).toBe(true);
    expect(rhcDiscoveryFindings(result).some((line) => line.startsWith("rhc candidate v4"))).toBe(true);
  });

  it("flags an allowlisted pool gone uninitialized and a changed or unreadable beacon", async () => {
    const gone = UNIV4_RHC_ALLOWLISTED_POOLS[0]!.poolId.toLowerCase();
    const allowlisted = new Set(UNIV4_RHC_ALLOWLISTED_POOLS.map((pool) => pool.poolId.toLowerCase()));
    const upgraded = getAddress("0x00000000000000000000000000000000000000bb");
    const { client } = mockClient({
      live: (id) => allowlisted.has(id) && id !== gone,
      implementation: (beacon) => (beacon === RHC_REGISTRY.beacons.robinhood.address ? upgraded : null),
    });
    const result = await discoverRhcRegistryPools(client);
    expect(result.allowlistedMissing.map((id) => id.toLowerCase())).toEqual([gone]);
    expect(result.beaconChanges).toEqual([
      { issuer: "robinhood", expected: RHC_REGISTRY.beacons.robinhood.implementation, actual: upgraded },
      { issuer: "ondo", expected: RHC_REGISTRY.beacons.ondo.implementation, actual: null },
    ]);
    expect(result.failedCalls).toBe(1);
    expect(result.candidates).toEqual([]);
  });
});
