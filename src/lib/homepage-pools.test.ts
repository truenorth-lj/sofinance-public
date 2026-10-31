import { describe, expect, it } from "vitest";
import { UNIV4_RHC_ALLOWLISTED_POOLS } from "@sofinance/engine/protocols/uniswap-v4/constants";
import { DEFAULT_FILTERS, DEFAULT_SORT, selectPools } from "@/lib/unified-pools/model";
import { rhcPool, solanaPool, type RhcPoolSummary } from "@/lib/unified-pools/rows";
import {
  aprLookupFrom,
  buildHomepagePools,
  formatAprPct,
  homepageRows,
  HOMEPAGE_POOL_LIMIT,
  rwaPairsDefaultOrder,
  toHomepagePoolsSnapshot,
  updatedLabel,
  utcMinuteLabel,
  type HomepageSolanaRow,
} from "./homepage-pools";

describe("homepage number labels", () => {
  it("formats est. APR to two decimals, like /app/rwa-pairs: <0.01% for a tiny real APR, 0.00% only for a true zero", () => {
    expect(formatAprPct(12.6)).toBe("12.60%");
    expect(formatAprPct(428.8)).toBe("428.80%");
    expect(formatAprPct(0.004)).toBe("<0.01%");
    expect(formatAprPct(0.0001)).toBe("<0.01%");
    expect(formatAprPct(0.01)).toBe("0.01%");
    expect(formatAprPct(0.03)).toBe("0.03%");
    expect(formatAprPct(0)).toBe("0.00%");
    expect(formatAprPct(null)).toBe("—");
  });

  it("prints the saved list time as an absolute UTC minute", () => {
    expect(utcMinuteLabel("2026-10-30T11:02:56.939Z")).toBe("2026-10-30 11:02 UTC");
    expect(utcMinuteLabel("not a time")).toBeNull();
    expect(utcMinuteLabel(new Date(0).toISOString())).toBeNull();
  });
});

describe("updatedLabel", () => {
  const at = (chain: "solana" | "robinhood", fetchedAt: string, stale = false) => ({ chain, fetchedAt, stale });

  it("shows one time when both chains were saved in the same minute", () => {
    expect(updatedLabel([at("solana", "2026-10-30T11:02:46.419Z"), at("robinhood", "2026-10-30T11:02:56.939Z")]))
      .toBe("Updated 2026-10-30 11:02 UTC");
  });

  it("names each chain when the times differ, and flags stale data", () => {
    expect(updatedLabel([at("solana", "2026-10-30T11:02:46Z"), at("robinhood", "2026-10-29T11:05:00Z", true)]))
      .toBe("Updated 2026-10-30 11:02 UTC (Solana) · 2026-10-29 11:05 UTC (Robinhood Chain) · Data delayed");
  });

  it("returns null without a usable time", () => {
    expect(updatedLabel([])).toBeNull();
    expect(updatedLabel([at("robinhood", new Date(0).toISOString())])).toBeNull();
  });
});

const solanaRow = (wrapped: string, plain: string, tvlUsd: number, extra: Partial<HomepageSolanaRow> = {}): HomepageSolanaRow => ({
  poolAddress: `${plain.toLowerCase()}-pool`,
  protocol: "raydium-clmm",
  mintA: `${wrapped}-mint`,
  mintB: `${plain}-mint`,
  symbolA: wrapped,
  symbolB: plain,
  nameA: wrapped,
  nameB: plain,
  wrappedSymbol: wrapped,
  plainSymbol: plain,
  feeTierBps: 25,
  tvlUsd,
  volume24hUsd: 1_000,
  estimatedFeeAprPct: 10,
  token2022A: true,
  token2022B: false,
  freezeRisk: false,
  wrapKind: "suffix-x",
  ...extra,
});

const rhcSummaries = (tvl = (i: number) => 41_000 + i * 1_000): RhcPoolSummary[] =>
  UNIV4_RHC_ALLOWLISTED_POOLS.map((spec, i) => ({
    poolId: spec.poolId,
    status: "listed",
    tick: 0,
    price: null,
    warnings: [],
    estimatedApr: { tvlUsd: tvl(i), volume24hUsd: 500, estimatedPoolFeeAprPct: 3 } as RhcPoolSummary["estimatedApr"],
    token0: { name: `${spec.currency0.symbol} token`, symbol: spec.currency0.symbol },
    token1: { name: `${spec.currency1.symbol} token`, symbol: spec.currency1.symbol },
  }) as RhcPoolSummary);

describe("buildHomepagePools / two chains", () => {
  const solana = [
    solanaRow("SPCXx", "SPCX", 262_029),
    solanaRow("SPCXx", "SPCX", 4_986, { poolAddress: "spcx-small" }),
    solanaRow("MSTRx", "MSTR", 66_362),
    solanaRow("SNDKx", "SNDK", 19_508),
    solanaRow("NVDAx", "NVDA", 8_566),
    solanaRow("USDC", "USDT", 1_816_304, { poolAddress: "usdc-usdt", wrapKind: "stable" }),
  ];

  it("merges both chains into one list by 7-day APR (high to low) and shows at most 5 pools", () => {
    const pools = buildHomepagePools({ solana, rhc: rhcSummaries() });
    const key = (address: string) => pools.find((row) => row.poolAddress === address)!.key;
    const rhcKey = (i: number) => pools.find((row) => row.poolAddress.toLowerCase() === rhcSummaries()[i]!.poolId.toLowerCase())!.key;
    const apr7d = aprLookupFrom({
      [key("sndk-pool")]: 103.5, [key("spcx-pool")]: 31.85, [key("mstr-pool")]: 15.27, [key("usdc-usdt")]: 4.72,
      [rhcKey(3)]: 0.8, [rhcKey(4)]: 0.65, [rhcKey(5)]: 0.004,
    });
    const rows = homepageRows(pools, apr7d);
    expect(HOMEPAGE_POOL_LIMIT).toBe(5);
    expect(rows.map((row) => [row.chain, row.poolAddress])).toEqual([
      ["solana", "sndk-pool"], ["solana", "spcx-pool"], ["solana", "mstr-pool"], ["solana", "usdc-usdt"],
      ["robinhood", rhcSummaries()[3]!.poolId],
    ]);
    // Fewer pools than the limit: all of them (one per pair), still by APR.
    expect(homepageRows(pools.slice(0, 3), apr7d).map((row) => row.poolAddress)).toEqual(["spcx-pool", "mstr-pool"]);
  });

  it("keeps every candidate pool, and applies the /app/rwa-pairs duplicate rule per chain without merging chains", () => {
    const pools = buildHomepagePools({ solana, rhc: rhcSummaries() });
    expect(pools.filter((row) => row.pairLabel === "SPCXx/SPCX").map((row) => row.poolAddress)).toEqual(["spcx-pool", "spcx-small"]);
    // No 7-day APR anywhere: the higher-TVL pool wins (the /app/rwa-pairs tie-break), and the list falls back to TVL order.
    const noApr = rwaPairsDefaultOrder(pools, () => null);
    expect(noApr.filter((row) => row.pairLabel === "SPCXx/SPCX").map((row) => row.poolAddress)).toEqual(["spcx-pool"]);
    expect(noApr.some((row) => row.chain === "robinhood" && row.pairLabel === "SPCX/SPCXon")).toBe(true);
    expect(homepageRows(pools, () => null).map((row) => row.poolAddress)[0]).toBe("usdc-usdt");
  });

  it("keeps the highest 7-day APR pool per pair even when another pool has more TVL (LJ's rule)", () => {
    const pools = buildHomepagePools({ solana, rhc: rhcSummaries() });
    const key = (address: string) => pools.find((row) => row.poolAddress === address)!.key;
    const apr7d = aprLookupFrom({ [key("spcx-small")]: 42, [key("spcx-pool")]: 3 });
    const ranked = rwaPairsDefaultOrder(pools, apr7d);
    expect(ranked.filter((row) => row.pairLabel === "SPCXx/SPCX").map((row) => row.poolAddress)).toEqual(["spcx-small"]);
    expect(homepageRows(pools, apr7d)[0]!.poolAddress).toBe("spcx-small");
    // A pool with any 7-day APR outranks one without, whatever its TVL.
    const onlySmall = rwaPairsDefaultOrder(pools, aprLookupFrom({ [key("spcx-small")]: 0.001 }));
    expect(onlySmall.filter((row) => row.pairLabel === "SPCXx/SPCX").map((row) => row.poolAddress)).toEqual(["spcx-small"]);
    expect(onlySmall[0]!.poolAddress).toBe("spcx-small");
  });

  it("puts a shared link's pool in the last slot when it is not in the top 5", () => {
    const pools = buildHomepagePools({ solana, rhc: rhcSummaries() });
    const rows = homepageRows(pools, () => null, "nvda-pool");
    expect(rows).toHaveLength(HOMEPAGE_POOL_LIMIT);
    expect(rows.at(-1)!.poolAddress).toBe("nvda-pool");
    expect(homepageRows(pools, () => null, "unknown-pool")).toEqual(homepageRows(pools, () => null));
  });

  it("orders Robinhood Chain pairs as Robinhood token / Ondo token, whatever the pool's currency order", () => {
    const labels = buildHomepagePools({ rhc: rhcSummaries() }).map((row) => row.pairLabel);
    expect(labels).toEqual(expect.arrayContaining(["MSTR/MSTRon", "AAPL/AAPLon", "TSLA/TSLAon", "META/METAon", "SPCX/SPCXon"]));
    expect(labels.every((label) => /^([A-Z]+)\/\1on$/.test(label))).toBe(true);
  });

  it("tags Robinhood Chain rows with chain, protocol and a dynamic (null) fee tier, and skips delisted pools", () => {
    const summaries = rhcSummaries();
    summaries[0] = { ...summaries[0]!, status: "delisted" } as RhcPoolSummary;
    const pools = buildHomepagePools({ rhc: summaries });
    expect(pools).toHaveLength(10);
    expect(pools[0]).toMatchObject({ chain: "robinhood", protocol: "uniswap-v4-rhc", feeTierBps: null });
  });

  it("builds a snapshot with both chains' times and only the icons the candidate pools use", () => {
    const rhc = rhcSummaries();
    const rhcAddress = UNIV4_RHC_ALLOWLISTED_POOLS[0]!.currency0.address;
    const snapshot = toHomepagePoolsSnapshot({
      solana: {
        pairs: solana,
        fetchedAt: "2026-10-30T11:02:46.419Z",
        stale: false,
        tokenIcons: {
          solana: { "SPCXx-mint": "https://example.test/spcxx.png", "NVDAx-mint": "https://example.test/nvdax.png" },
          robinhood: { [rhcAddress.toLowerCase()]: "https://example.test/rhc.png", "0xunused": "https://example.test/u.png" },
        },
      },
      rhc: { pools: rhc, fetchedAt: "2026-10-30T11:02:56.939Z", stale: false },
    });
    // Every candidate (6 Solana + 11 Robinhood Chain), so the client can re-run the /app/rwa-pairs pick.
    expect(snapshot.pools).toHaveLength(17);
    expect(snapshot.tokenIcons).toEqual({
      solana: { "SPCXx-mint": "https://example.test/spcxx.png", "NVDAx-mint": "https://example.test/nvdax.png" },
      robinhood: { [rhcAddress.toLowerCase()]: "https://example.test/rhc.png" },
    });
    expect(snapshot.updated.map((entry) => entry.chain)).toEqual(["solana", "robinhood"]);
    expect(updatedLabel(snapshot.updated)).toBe("Updated 2026-10-30 11:02 UTC");
  });

  it("renders one chain when the other is unavailable", () => {
    const snapshot = toHomepagePoolsSnapshot({ solana: null, rhc: { pools: rhcSummaries(), fetchedAt: "2026-10-30T11:02:56.939Z", stale: false } });
    expect(snapshot.pools.every((row) => row.chain === "robinhood")).toBe(true);
    expect(snapshot.updated).toEqual([{ chain: "robinhood", fetchedAt: "2026-10-30T11:02:56.939Z", stale: false }]);
  });

  it("keeps only 7-day APRs of its own candidate pools in the snapshot", () => {
    const pools = buildHomepagePools({ solana });
    const snapshot = toHomepagePoolsSnapshot({
      solana: { pairs: solana, fetchedAt: "2026-10-30T11:02:46.419Z", stale: false },
      apr7d: { [pools[0]!.key]: 12.5, "solana:gone": 99, [pools[1]!.key]: Number.NaN },
    });
    expect(snapshot.apr7d).toEqual({ [pools[0]!.key]: 12.5 });
  });
});

describe("homepage pools match /app/rwa-pairs", () => {
  // The same rows /app/rwa-pairs builds (solanaPool / rhcPool), with duplicates on both chains and APR winners that
  // are not the TVL winners.
  const solanaRows = [
    solanaRow("SPCXx", "SPCX", 262_029),
    solanaRow("SPCXx", "SPCX", 4_986, { poolAddress: "spcx-small" }),
    solanaRow("SPCXx", "SPCX", 90_000, { poolAddress: "spcx-mid" }),
    solanaRow("MSTRx", "MSTR", 66_362),
    solanaRow("MSTRx", "MSTR", 70_000, { poolAddress: "mstr-big" }),
    solanaRow("SNDKx", "SNDK", 19_508),
    solanaRow("USDC", "USDT", 1_816_304, { poolAddress: "usdc-usdt", wrapKind: "stable" }),
  ];
  const rhc = rhcSummaries((i) => 20_000 + ((i * 7919) % 11) * 3_000);
  const candidates = buildHomepagePools({ solana: solanaRows, rhc });
  const byAddress = (address: string) => candidates.find((row) => row.poolAddress === address)!.key;
  const apr7d = aprLookupFrom({
    [byAddress("spcx-small")]: 18.4,
    [byAddress("spcx-pool")]: 2.1,
    [byAddress("spcx-mid")]: 18.4, // tie on APR: higher TVL (spcx-mid) wins, as on /app/rwa-pairs
    [byAddress("mstr-pool")]: 0.004, // below 0.01% still beats no APR
    [byAddress(rhc[2]!.poolId)]: 7.5,
  });
  // What /app/rwa-pairs shows by default (hide duplicates on, no filters, sort by 7d APR), from the same pools.
  const rwaPairsPools = [...solanaRows.map(solanaPool), ...rhc.map(rhcPool).filter((row) => row !== null)];
  const rwaPairs = selectPools(rwaPairsPools, { filters: DEFAULT_FILTERS, hideDuplicates: true, sort: DEFAULT_SORT, apr7d }).pools;
  const pairKey = (row: { chain: string; pairLabel: string }) => `${row.chain}:${row.pairLabel}`;

  it("picks the identical pool for every chain and pair, in the identical order", () => {
    const home = rwaPairsDefaultOrder(candidates, apr7d);
    expect(home.map((row) => row.key)).toEqual(rwaPairs.map((row) => row.key));
    expect(Object.fromEntries(home.map((row) => [pairKey(row), row.poolAddress]))).toMatchObject({
      "solana:SPCXx/SPCX": "spcx-mid",
      "solana:MSTRx/MSTR": "mstr-pool",
    });
  });

  it("shows the first 5 pools of /app/rwa-pairs' default view, with the same pair labels", () => {
    const shown = homepageRows(candidates, apr7d);
    expect(shown.map((row) => row.key)).toEqual(rwaPairs.slice(0, HOMEPAGE_POOL_LIMIT).map((row) => row.key));
    expect(shown.map((row) => row.pairLabel)).toEqual(rwaPairs.slice(0, HOMEPAGE_POOL_LIMIT).map((row) => row.pairLabel));
  });
});
