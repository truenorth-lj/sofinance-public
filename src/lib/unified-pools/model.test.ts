import { describe, expect, it } from "vitest";
import {
  DEFAULT_FILTERS, DEFAULT_SORT, TVL_FILTER_PRESETS, compareDuplicateRank, filterPools, hideDuplicatePools, isLowTvl, LOW_TVL_USD, meetsMinTvl, openUnavailableReason,
  poolRankGroup, poolRankGroupOf, samePairKey, selectPools, sortPools, unsupportedTokenReason,
  type UnifiedPool,
} from "./model";

const pool = (over: Partial<UnifiedPool> & Pick<UnifiedPool, "poolAddress">): UnifiedPool => ({
  key: `${over.chain ?? "solana"}:${over.poolAddress}`, chain: "solana", protocol: "raydium-clmm", pairLabel: "SPCXx/SPCX",
  symbolA: "SPCXx", symbolB: "SPCX", nameA: "SpaceX xStock", nameB: "SpaceX", mintA: "mintX", mintB: "mintS", feeTierBps: 25,
  tvlUsd: 1000, volume24hUsd: 100, poolFeeApr24hPct: 10, ...over,
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

describe("same-protocol duplicates (PM 2026-11-01)", () => {
  it("keys include the protocol, so the same pair on Raydium and Meteora is two rows", () => {
    const ray = pool({ poolAddress: "ray" }), met = pool({ poolAddress: "met", protocol: "meteora-dlmm" });
    expect(samePairKey(ray)).not.toBe(samePairKey(met));
    expect(hideDuplicatePools([ray, met], aprs({ ray: 1, met: 2 })).map((p) => p.poolAddress)).toEqual(["ray", "met"]);
    expect(hideDuplicatePools([met, pool({ poolAddress: "met2", protocol: "meteora-dlmm" })], aprs({ met: 1, met2: 2 }))
      .map((p) => p.poolAddress)).toEqual(["met2"]);
  });
  it("Meteora pools cannot be opened from the list, with the reason shown", () => {
    expect(openUnavailableReason({ protocol: "meteora-dlmm" })).toBe("Opening Meteora positions isn't available yet");
    for (const protocol of ["raydium-clmm", "orca-whirlpool", "uniswap-v4-rhc"] as const) expect(openUnavailableReason({ protocol })).toBeNull();
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
    pool({ poolAddress: "tsla", pairLabel: "TSLAx/TSLA", symbolA: "TSLAx", symbolB: "TSLA", nameA: "Tesla xStock", nameB: "Tesla", mintA: "t1", mintB: "t2" }),
    pool({ poolAddress: "0xrh", chain: "robinhood", protocol: "uniswap-v4-rhc", pairLabel: "SPCX/SPCXon", symbolA: "SPCX", symbolB: "SPCXon", nameA: "SpaceX", nameB: "SpaceX Ondo" }),
  ];
  const ids = (f: Partial<typeof DEFAULT_FILTERS>) => filterPools(list, { ...DEFAULT_FILTERS, ...f }).map((p) => p.poolAddress);
  it("searches symbols and names, case-insensitive, every word", () => {
    expect(ids({ query: "tesla" })).toEqual(["tsla"]);
    expect(ids({ query: "spcx" })).toEqual(["spcx", "0xrh"]);
    expect(ids({ query: "spacex ondo" })).toEqual(["0xrh"]);
    expect(ids({ query: "SPCXx/SPCX" })).toEqual(["spcx"]);
  });
  it("filters by chain and protocol", () => {
    expect(ids({ chain: "robinhood" })).toEqual(["0xrh"]);
    expect(ids({ protocol: "raydium-clmm" })).toEqual(["spcx", "tsla"]);
  });
  it("has no risk filter: a stray risk value (e.g. an old ?risk= link) is ignored and every pool stays listed", () => {
    expect(Object.keys(DEFAULT_FILTERS)).not.toContain("risk");
    const stray = { ...DEFAULT_FILTERS, risk: "freeze" } as typeof DEFAULT_FILTERS;
    expect(filterPools(list, stray).map((p) => p.poolAddress)).toEqual(["spcx", "tsla", "0xrh"]);
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

describe("TVL filter (minTvl)", () => {
  // META's two Solana pools: a tiny pool with a very high 7d APR and a bigger pool of the same pair with a lower one.
  const meta = (over: Partial<UnifiedPool> & Pick<UnifiedPool, "poolAddress">) => pool({
    pairLabel: "METAx/META", symbolA: "METAx", symbolB: "META", nameA: "Meta xStock", nameB: "Meta", mintA: "mintMetaX", mintB: "mintMeta", ...over,
  });
  const tinyMeta = meta({ poolAddress: "metaTiny", tvlUsd: 1_023.91 });
  const bigMeta = meta({ poolAddress: "metaBig", tvlUsd: 48_000, mintA: "mintMeta", mintB: "mintMetaX" });
  const spcx = pool({ poolAddress: "spcx", tvlUsd: 265_900 });
  const list = [tinyMeta, bigMeta, spcx];
  const apr7d = aprs({ metaTiny: 673.66, metaBig: 40, spcx: 31.85 });
  const select = (minTvl: number | null, hideDuplicates = true) =>
    selectPools(list, { filters: { ...DEFAULT_FILTERS, minTvl }, hideDuplicates, sort: DEFAULT_SORT, apr7d });

  it("defaults to Any: the tiny META pool still wins its pair, and ranks after the $5k+ pools (Low TVL)", () => {
    expect(DEFAULT_FILTERS.minTvl).toBeNull();
    const out = select(null);
    expect(out.pools.map((p) => p.poolAddress)).toEqual(["spcx", "metaTiny"]);
    expect(out.hiddenDuplicates).toBe(1);
  });
  it("filters by TVL before the duplicate rule: the tiny META pool never hides the big META pool", () => {
    for (const minTvl of TVL_FILTER_PRESETS.filter((usd) => usd <= 48_000)) {
      const out = select(minTvl);
      expect(out.pools.map((p) => p.poolAddress)).toEqual(["metaBig", "spcx"]);
      expect(out.hiddenDuplicates).toBe(0);
    }
  });
  it("drops the whole pair only when every pool of it is under the minimum", () => {
    expect(select(50_000).pools.map((p) => p.poolAddress)).toEqual(["spcx"]);
  });
  it("takes a custom amount, inclusive", () => {
    expect(select(48_000).pools.map((p) => p.poolAddress)).toEqual(["metaBig", "spcx"]);
    expect(select(48_000.01).pools.map((p) => p.poolAddress)).toEqual(["spcx"]);
  });
  it("applies with Hide duplicate pools off as well, and alongside the search", () => {
    expect(select(5_000, false).pools.map((p) => p.poolAddress)).toEqual(["metaBig", "spcx"]);
    const out = selectPools(list, { filters: { ...DEFAULT_FILTERS, query: "meta", minTvl: 5_000 }, hideDuplicates: true, sort: DEFAULT_SORT, apr7d });
    expect(out.pools.map((p) => p.poolAddress)).toEqual(["metaBig"]);
  });
  it("treats an unknown TVL as failing any minimum", () => {
    expect(meetsMinTvl({ tvlUsd: null }, 5_000)).toBe(false);
    expect(meetsMinTvl({ tvlUsd: null }, null)).toBe(true);
    expect(meetsMinTvl({ tvlUsd: 5_000 }, 5_000)).toBe(true);
  });
});

describe("APR rank groups: normal, Low TVL, New pool, Not supported yet (PM 2026-11-04)", () => {
  // Real figures: NVDAx FjUo…KKS $10.5k (balance multiplier), INTCx 9Ur3 $1,884 (new by the strict count), GOOGLx $1,932, SKHYx $126.
  const big = pool({ poolAddress: "big", pairLabel: "SPCXx/SPCX", tvlUsd: 262_029 });
  const bigNoApr = pool({ poolAddress: "bigNoApr", pairLabel: "USDC/USDT", mintA: "u1", mintB: "u2", tvlUsd: 1_800_000 });
  const googl = pool({ poolAddress: "googl", pairLabel: "GOOGLx/GOOGL", mintA: "g1", mintB: "g2", tvlUsd: 1_932 });
  const skhy = pool({ poolAddress: "skhy", pairLabel: "SKHYx/SKHY", mintA: "s1", mintB: "s2", tvlUsd: 126 });
  const intc = pool({ poolAddress: "intc", pairLabel: "INTCx/INTC", mintA: "i1", mintB: "i2", tvlUsd: 1_884 });
  const nvda = pool({ poolAddress: "nvda", pairLabel: "NVDAx/NVDA", mintA: "n1", mintB: "n2", tvlUsd: 10_500,
    unsupportedIssues: ["ScaledUiAmount multiplier not 1"] });
  const all = [nvda, intc, skhy, googl, bigNoApr, big];
  const apr7d = aprs({ big: 12, googl: 40, skhy: 90, nvda: 500 });
  const group = (p: UnifiedPool) => poolRankGroup(p, p.poolAddress === "intc");

  it("Low TVL is under $5k; a pool with unknown TVL is not tagged", () => {
    expect(LOW_TVL_USD).toBe(5_000);
    expect(isLowTvl(googl)).toBe(true);
    expect(isLowTvl(pool({ poolAddress: "x", tvlUsd: 5_000 }))).toBe(false);
    expect(isLowTvl(pool({ poolAddress: "x", tvlUsd: null }))).toBe(false);
  });
  it("orders the groups the same way in both APR directions; inside a group by APR, then TVL", () => {
    expect(sortPools(all, "apr7d", "desc", apr7d, group).map((p) => p.poolAddress)).toEqual(["big", "bigNoApr", "skhy", "googl", "intc", "nvda"]);
    expect(sortPools(all, "apr7d", "asc", apr7d, group).map((p) => p.poolAddress)).toEqual(["big", "bigNoApr", "googl", "skhy", "intc", "nvda"]);
    expect(selectPools(all, { filters: DEFAULT_FILTERS, hideDuplicates: true, sort: DEFAULT_SORT, apr7d, group }).pools.map((p) => p.poolAddress))
      .toEqual(["big", "bigNoApr", "skhy", "googl", "intc", "nvda"]);
  });
  it("other columns keep their plain order (no groups)", () => {
    expect(sortPools(all, "tvl", "desc", apr7d, group).map((p) => p.poolAddress)).toEqual(["bigNoApr", "big", "nvda", "googl", "intc", "skhy"]);
  });
  it("without APR states, Not supported yet and Low TVL still apply (poolRankGroupOf)", () => {
    expect(all.map(poolRankGroupOf)).toEqual([3, 1, 1, 1, 0, 0]);
    expect(poolRankGroup(skhy, true)).toBe(2);
    expect(poolRankGroup(nvda, true)).toBe(3);
  });
  it("names the reason in plain words", () => {
    expect(unsupportedTokenReason(nvda)).toBe("This token uses a balance multiplier, which we don't support yet.");
    expect(unsupportedTokenReason(pool({ poolAddress: "h", unsupportedIssues: ["TransferHook enabled"] })))
      .toBe("This token runs extra checks on every transfer, which we don't support yet.");
    expect(unsupportedTokenReason(pool({ poolAddress: "e", unsupportedIssues: ["Unsupported extension 23"] }))).toBe("This token uses a setting we don't support yet.");
    expect(unsupportedTokenReason(big)).toBeNull();
    expect(unsupportedTokenReason(pool({ poolAddress: "z", unsupportedIssues: [] }))).toBeNull();
  });
});
