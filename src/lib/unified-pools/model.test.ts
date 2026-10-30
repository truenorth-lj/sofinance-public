import { describe, expect, it } from "vitest";
import {
  DEFAULT_FILTERS, DEFAULT_SORT, compareDuplicateRank, filterPools, hideDuplicatePools, samePairKey, selectPools, sortPools,
  type UnifiedPool,
} from "./model";

const pool = (over: Partial<UnifiedPool> & Pick<UnifiedPool, "poolAddress">): UnifiedPool => ({
  key: `${over.chain ?? "solana"}:${over.poolAddress}`, chain: "solana", protocol: "raydium-clmm", pairLabel: "SPCXx/SPCX",
  symbolA: "SPCXx", symbolB: "SPCX", nameA: "SpaceX xStock", nameB: "SpaceX", mintA: "mintX", mintB: "mintS", feeTierBps: 25,
  tvlUsd: 1000, volume24hUsd: 100, poolFeeApr24hPct: 10, risks: [], ...over,
});
const aprs = (map: Record<string, number | null>) => (p: UnifiedPool) => map[p.poolAddress] ?? null;

describe("samePairKey", () => {
  it("matches A/B with B/A on one chain", () => {
    expect(samePairKey(pool({ poolAddress: "p1" }))).toBe(samePairKey(pool({ poolAddress: "p2", mintA: "mintS", mintB: "mintX" })));
  });
  it("never matches across chains", () => {
    expect(samePairKey(pool({ poolAddress: "p1" }))).not.toBe(samePairKey(pool({ poolAddress: "p1", chain: "robinhood" })));
  });
  it("ignores EVM address case but keeps Solana mint case", () => {
    expect(samePairKey(pool({ poolAddress: "a", chain: "robinhood", mintA: "0xAB", mintB: "0xcd" })))
      .toBe(samePairKey(pool({ poolAddress: "b", chain: "robinhood", mintA: "0xab", mintB: "0xCD" })));
    expect(samePairKey(pool({ poolAddress: "a", mintA: "Ab" }))).not.toBe(samePairKey(pool({ poolAddress: "b", mintA: "ab" })));
  });
});

describe("hideDuplicatePools", () => {
  it("keeps the highest 7d APR pool of a pair, whatever its TVL (no TVL threshold)", () => {
    const list = [pool({ poolAddress: "big", tvlUsd: 1_000_000 }), pool({ poolAddress: "tiny", tvlUsd: 5, mintA: "mintS", mintB: "mintX" })];
    expect(hideDuplicatePools(list, aprs({ big: 20, tiny: 80 })).map((p) => p.poolAddress)).toEqual(["tiny"]);
  });
  it("ranks a pool without a 7d APR below any pool with one", () => {
    const list = [pool({ poolAddress: "none", tvlUsd: 1e9 }), pool({ poolAddress: "low", tvlUsd: 1 })];
    expect(hideDuplicatePools(list, aprs({ low: 0.5 })).map((p) => p.poolAddress)).toEqual(["low"]);
  });
  it("without any 7d APR breaks ties by TVL, then 24h volume, then address", () => {
    expect(hideDuplicatePools([pool({ poolAddress: "a", tvlUsd: 1 }), pool({ poolAddress: "b", tvlUsd: 2 })], aprs({}))[0]!.poolAddress).toBe("b");
    expect(hideDuplicatePools([pool({ poolAddress: "a", volume24hUsd: 1 }), pool({ poolAddress: "b", volume24hUsd: 2 })], aprs({}))[0]!.poolAddress).toBe("b");
    expect(hideDuplicatePools([pool({ poolAddress: "b" }), pool({ poolAddress: "a" })], aprs({}))[0]!.poolAddress).toBe("a");
    expect(compareDuplicateRank(pool({ poolAddress: "a" }), pool({ poolAddress: "a" }), aprs({}))).toBe(0);
  });
  it("keeps the Robinhood Chain SPCX/SPCXon and the Solana SPCX/SPCXx pools side by side", () => {
    const list = [
      pool({ poolAddress: "sol1" }), pool({ poolAddress: "sol2" }),
      pool({ poolAddress: "0xrh", chain: "robinhood", protocol: "uniswap-v4-rhc", pairLabel: "SPCX/SPCXon", mintA: "0xa", mintB: "0xb" }),
    ];
    expect(hideDuplicatePools(list, aprs({ sol1: 1, sol2: 2 })).map((p) => p.poolAddress)).toEqual(["sol2", "0xrh"]);
  });
});

describe("filterPools", () => {
  const list = [
    pool({ poolAddress: "spcx" }),
    pool({ poolAddress: "tsla", pairLabel: "TSLAx/TSLA", symbolA: "TSLAx", symbolB: "TSLA", nameA: "Tesla xStock", nameB: "Tesla", mintA: "t1", mintB: "t2", risks: ["freeze"] }),
    pool({ poolAddress: "0xrh", chain: "robinhood", protocol: "uniswap-v4-rhc", pairLabel: "SPCX/SPCXon", symbolA: "SPCX", symbolB: "SPCXon", nameA: "SpaceX", nameB: "SpaceX Ondo", risks: ["pool-warning"] }),
  ];
  const ids = (f: Partial<typeof DEFAULT_FILTERS>) => filterPools(list, { ...DEFAULT_FILTERS, ...f }).map((p) => p.poolAddress);
  it("searches symbols and names, case-insensitive, every word", () => {
    expect(ids({ query: "tesla" })).toEqual(["tsla"]);
    expect(ids({ query: "spcx" })).toEqual(["spcx", "0xrh"]);
    expect(ids({ query: "spacex ondo" })).toEqual(["0xrh"]);
    expect(ids({ query: "SPCXx/SPCX" })).toEqual(["spcx"]);
  });
  it("filters by chain, protocol and risk", () => {
    expect(ids({ chain: "robinhood" })).toEqual(["0xrh"]);
    expect(ids({ protocol: "raydium-clmm" })).toEqual(["spcx", "tsla"]);
    expect(ids({ risk: "none" })).toEqual(["spcx"]);
    expect(ids({ risk: "freeze" })).toEqual(["tsla"]);
  });
});

describe("sortPools", () => {
  const list = [pool({ poolAddress: "a", pairLabel: "B", tvlUsd: 3 }), pool({ poolAddress: "b", pairLabel: "A", tvlUsd: 1 }), pool({ poolAddress: "c", pairLabel: "C", tvlUsd: 2 })];
  const apr = aprs({ a: 10, b: 30 });
  it("sorts 7d APR high to low by default with missing values last", () => {
    expect(sortPools(list, DEFAULT_SORT.key, DEFAULT_SORT.dir, apr).map((p) => p.poolAddress)).toEqual(["b", "a", "c"]);
  });
  it("keeps missing values last when ascending too", () => {
    expect(sortPools(list, "apr7d", "asc", apr).map((p) => p.poolAddress)).toEqual(["a", "b", "c"]);
  });
  it("sorts by name, TVL, volume and chain", () => {
    expect(sortPools(list, "name", "asc", apr).map((p) => p.pairLabel)).toEqual(["A", "B", "C"]);
    expect(sortPools(list, "tvl", "desc", apr).map((p) => p.poolAddress)).toEqual(["a", "c", "b"]);
    const mixed = [pool({ poolAddress: "s" }), pool({ poolAddress: "r", chain: "robinhood" })];
    expect(sortPools(mixed, "chain", "asc", apr).map((p) => p.chain)).toEqual(["robinhood", "solana"]);
  });
});

describe("selectPools", () => {
  const list = [pool({ poolAddress: "best" }), pool({ poolAddress: "worse", nameA: "Other name" })];
  it("hides duplicates by default and reports how many", () => {
    const out = selectPools(list, { filters: DEFAULT_FILTERS, hideDuplicates: true, sort: DEFAULT_SORT, apr7d: aprs({ best: 9, worse: 1 }) });
    expect(out.pools.map((p) => p.poolAddress)).toEqual(["best"]);
    expect(out.hiddenDuplicates).toBe(1);
  });
  it("shows all pools when hiding is off", () => {
    const out = selectPools(list, { filters: DEFAULT_FILTERS, hideDuplicates: false, sort: DEFAULT_SORT, apr7d: aprs({ best: 9, worse: 1 }) });
    expect(out.pools).toHaveLength(2);
    expect(out.hiddenDuplicates).toBe(0);
  });
  it("decides duplicates before the search, so a search never promotes the hidden pool", () => {
    const out = selectPools(list, { filters: { ...DEFAULT_FILTERS, query: "other" }, hideDuplicates: true, sort: DEFAULT_SORT, apr7d: aprs({ best: 9, worse: 1 }) });
    expect(out.pools).toEqual([]);
    expect(out.hiddenDuplicates).toBe(1);
  });
});
