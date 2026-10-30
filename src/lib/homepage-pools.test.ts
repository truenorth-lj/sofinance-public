import { describe, expect, it } from "vitest";
import { UNIV4_RHC_ALLOWLISTED_POOLS } from "@sofinance/engine/protocols/uniswap-v4/constants";
import type { RhcPoolSummary } from "@/lib/unified-pools/rows";
import {
  buildHomepagePools,
  formatAprPct,
  formatUsd,
  HOMEPAGE_POOL_LIMIT,
  HOMEPAGE_TVL_FLOOR_USD,
  selectHomepagePools,
  sortPoolsByTvl,
  toHomepagePoolsSnapshot,
  updatedLabel,
  utcMinuteLabel,
  type HomepageSolanaRow,
} from "./homepage-pools";

const pool = (id: string, tvlUsd: number | null, apr = 10) => ({
  poolAddress: id,
  tvlUsd,
  estimatedFeeAprPct: apr,
});

describe("sortPoolsByTvl", () => {
  it("ranks the largest TVL first so a tiny high-APR pool does not headline", () => {
    const rows = sortPoolsByTvl([
      pool("sndk", 953, 428.8),
      pool("spcx", 256_900, 12.6),
      pool("amd", 1_200, 135.6),
    ]);
    expect(rows.map((row) => row.poolAddress)).toEqual(["spcx", "amd", "sndk"]);
  });

  it("treats missing TVL as the bottom of the list", () => {
    const rows = sortPoolsByTvl([pool("none", null, 999), pool("mid", 5_000, 1)]);
    expect(rows.map((row) => row.poolAddress)).toEqual(["mid", "none"]);
  });
});

describe("selectHomepagePools", () => {
  it("drops sub-floor TVL pools when larger ones exist, and caps the list", () => {
    const rows = Array.from({ length: HOMEPAGE_POOL_LIMIT + 2 }, (_, i) => pool(`big-${i}`, HOMEPAGE_TVL_FLOOR_USD + i * 1_000));
    rows.push(pool("sndk", 953, 428.8));
    const picked = selectHomepagePools(rows);
    expect(picked).toHaveLength(HOMEPAGE_POOL_LIMIT);
    expect(picked[0]?.poolAddress).toBe(`big-${HOMEPAGE_POOL_LIMIT + 1}`);
    expect(picked.some((row) => row.poolAddress === "sndk")).toBe(false);
  });

  it("falls back to TVL order when every pool is below the floor", () => {
    const picked = selectHomepagePools([
      pool("sndk", 953, 428.8),
      pool("amd", 1_200, 135.6),
    ]);
    expect(picked.map((row) => row.poolAddress)).toEqual(["amd", "sndk"]);
  });

  it("swaps in a highlighted pool that would otherwise be clipped", () => {
    const rows = Array.from({ length: HOMEPAGE_POOL_LIMIT + 2 }, (_, i) =>
      pool(`big-${i}`, HOMEPAGE_TVL_FLOOR_USD + 50_000 + i),
    );
    rows.push(pool("tweet-pool", HOMEPAGE_TVL_FLOOR_USD + 1, 8));
    const picked = selectHomepagePools(rows, "tweet-pool");
    expect(picked).toHaveLength(HOMEPAGE_POOL_LIMIT);
    expect(picked.at(-1)?.poolAddress).toBe("tweet-pool");
  });
});

describe("homepage number labels", () => {
  it("formats TVL the way pair cards do", () => {
    expect(formatUsd(256_900)).toBe("$256.9k");
    expect(formatUsd(1_250_000)).toBe("$1.25M");
    expect(formatUsd(953)).toBe("$953.00");
    expect(formatUsd(null)).toBe("—");
  });

  it("formats est. APR to two decimals", () => {
    expect(formatAprPct(12.6)).toBe("12.60%");
    expect(formatAprPct(428.8)).toBe("428.80%");
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

  it("lists both chains with every Robinhood Chain StablePair pool, same-stock pools by TVL, USDC/USDT last", () => {
    const rows = selectHomepagePools(buildHomepagePools({ solana, rhc: rhcSummaries() }));
    expect(UNIV4_RHC_ALLOWLISTED_POOLS).toHaveLength(11);
    expect(rows.filter((row) => row.chain === "robinhood")).toHaveLength(11);
    expect(rows.filter((row) => row.chain === "solana").map((row) => row.pairLabel)).toEqual(["SPCXx/SPCX", "MSTRx/MSTR", "SNDKx/SNDK", "USDC/USDT"]);
    expect(rows.at(-1)).toMatchObject({ pairLabel: "USDC/USDT", sameAsset: false });
    const sameStock = rows.slice(0, -1);
    expect(sameStock.every((row) => row.sameAsset)).toBe(true);
    expect(sameStock.map((row) => row.tvlUsd)).toEqual([...sameStock.map((row) => row.tvlUsd)].sort((a, b) => (b ?? 0) - (a ?? 0)));
    // Sub-floor pools stay off the homepage when larger ones exist.
    expect(rows.some((row) => row.pairLabel === "NVDAx/NVDA")).toBe(false);
  });

  it("applies the /app/rwa-pairs duplicate rule per chain (higher TVL wins without a 7d APR) and never merges chains", () => {
    const pools = buildHomepagePools({ solana, rhc: rhcSummaries() });
    expect(pools.filter((row) => row.chain === "solana" && row.pairLabel === "SPCXx/SPCX").map((row) => row.poolAddress)).toEqual(["spcx-pool"]);
    expect(pools.some((row) => row.chain === "robinhood" && row.pairLabel === "SPCX/SPCXon")).toBe(true);
  });

  it("tags Robinhood Chain rows with chain, protocol and a dynamic (null) fee tier, and skips delisted pools", () => {
    const summaries = rhcSummaries();
    summaries[0] = { ...summaries[0]!, status: "delisted" } as RhcPoolSummary;
    const pools = buildHomepagePools({ rhc: summaries });
    expect(pools).toHaveLength(10);
    expect(pools[0]).toMatchObject({ chain: "robinhood", protocol: "uniswap-v4-rhc", feeTierBps: null, sameAsset: true });
    expect(pools[0]!.wrappedSymbol).toBe(pools[0]!.symbolA);
  });

  it("builds a snapshot with both chains' times and only the icons the shown rows use", () => {
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
    expect(snapshot.pools).toHaveLength(15);
    expect(snapshot.tokenIcons).toEqual({
      solana: { "SPCXx-mint": "https://example.test/spcxx.png" },
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
});
