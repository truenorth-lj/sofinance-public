import { describe, expect, it } from "vitest";
import type { HomepagePool, HomepagePoolsSnapshot } from "@/lib/homepage-pools";
import { USDC_MINT, USDT_MINT } from "@/lib/rwa-allowlist";
import {
  PUBLIC_POOLS_APR_COLUMN,
  PUBLIC_POOLS_H1,
  PUBLIC_POOLS_INTRO,
  publicPoolRows,
  publicPoolsItemListJsonLd,
  toPublicPoolRow,
} from "./public-pools-table";

const pool = (extra: Partial<HomepagePool> & Pick<HomepagePool, "key" | "protocol" | "poolAddress" | "symbolA" | "symbolB">): HomepagePool => ({
  chain: "solana",
  pairLabel: `${extra.symbolA}/${extra.symbolB}`,
  nameA: extra.symbolA,
  nameB: extra.symbolB,
  mintA: `${extra.symbolA}-mint`,
  mintB: `${extra.symbolB}-mint`,
  feeTierBps: 25,
  tvlUsd: 50_000,
  volume24hUsd: 2_000,
  poolFeeApr24hPct: 12,
  ...extra,
});

const raydium = pool({
  key: "solana:tsla-raydium",
  protocol: "raydium-clmm",
  poolAddress: "tsla-raydium",
  symbolA: "TSLAx",
  symbolB: "TSLA",
  tvlUsd: 80_000,
});
const meteora = pool({
  key: "solana:tsla-meteora",
  protocol: "meteora-dlmm",
  poolAddress: "tsla-meteora",
  symbolA: "TSLAx",
  symbolB: "TSLA",
  tvlUsd: 20_000,
  feeTierBps: 15,
});
const rhc = pool({
  key: "robinhood:0xspcx",
  chain: "robinhood",
  protocol: "uniswap-v4-rhc",
  poolAddress: "0xspcx",
  symbolA: "SPCX",
  symbolB: "SPCXon",
  feeTierBps: null,
  tvlUsd: 40_000,
});

const usdcUsdt = pool({
  key: "solana:usdc-usdt",
  protocol: "raydium-clmm",
  poolAddress: "usdc-usdt-pool",
  symbolA: "USDC",
  symbolB: "USDT",
  mintA: USDC_MINT,
  mintB: USDT_MINT,
  tvlUsd: 1_800_000,
});

const snapshot: HomepagePoolsSnapshot = {
  pools: [raydium, meteora, rhc, usdcUsdt],
  apr7d: { [raydium.key]: 18.5, [meteora.key]: 22.25, [rhc.key]: 9, [usdcUsdt.key]: 40 },
  updated: [],
};

describe("publicPoolRows", () => {
  it("lists Meteora DLMM alongside Raydium CLMM and Uniswap v4, in default 7-day order", () => {
    const rows = publicPoolRows(snapshot);
    expect(rows.map((row) => row.dex)).toEqual(["Meteora DLMM", "Raydium CLMM", "Uniswap v4"]);
    expect(rows[0]?.pairLabel).toBe("TSLAx / TSLA");
    expect(rows[0]?.apr7d).toBe("22.25%");
    expect(rows[0]?.href).toBe("/pools/tsla-tslax-meteora");
    expect(rows.find((row) => row.dex === "Raydium CLMM")?.href).toBe("/pools/tsla-tslax");
    expect(rows.find((row) => row.dex === "Uniswap v4")?.href).toBe("/pools/spcx-spcxon");
    expect(rows.some((row) => row.chain === "Solana")).toBe(true);
    expect(rows.some((row) => row.chain === "Robinhood Chain")).toBe(true);
  });

  it("returns no rows when the snapshot is missing", () => {
    expect(publicPoolRows(null)).toEqual([]);
  });

  it("omits the USDC/USDT pool from the SSR table and ItemList, and keeps stock pools", () => {
    const rows = publicPoolRows(snapshot);
    expect(rows.map((row) => row.pairLabel)).toEqual(["TSLAx / TSLA", "TSLAx / TSLA", "SPCX / SPCXon"]);
    expect(rows.map((row) => row.href)).not.toContain("/pools/usdc-usdt");
    expect(rows.some((row) => /USDC|USDT/.test(row.pairLabel))).toBe(false);
    const json = publicPoolsItemListJsonLd(snapshot);
    expect(json?.numberOfItems).toBe(3);
    const urls = (json?.itemListElement as { url: string }[]).map((item) => item.url);
    expect(urls).not.toContain("https://sofinancelab.xyz/pools/usdc-usdt");
    expect(urls).toEqual([
      "https://sofinancelab.xyz/pools/tsla-tslax-meteora",
      "https://sofinancelab.xyz/pools/tsla-tslax",
      "https://sofinancelab.xyz/pools/spcx-spcxon",
    ]);
  });

  it("formats a missing fee tier and missing 7-day estimate as a dash, never 0.00%", () => {
    const row = toPublicPoolRow({ ...rhc, feeTierBps: null, tvlUsd: null, volume24hUsd: null }, null, "/pools/spcx-spcxon");
    expect(row.feeTier).toBe("—");
    expect(row.tvl).toBe("—");
    expect(row.volume24h).toBe("—");
    expect(row.apr7d).toBe("—");
    expect(row.apr7d).not.toBe("0.00%");
  });
});

describe("publicPoolsItemListJsonLd", () => {
  it("emits an ItemList of the same rows, or null when empty", () => {
    const json = publicPoolsItemListJsonLd(snapshot);
    expect(json).toMatchObject({
      "@context": "https://schema.org",
      "@type": "ItemList",
      name: PUBLIC_POOLS_H1,
      numberOfItems: 3,
      url: "https://sofinancelab.xyz/pools",
    });
    const items = json?.itemListElement as { position: number; name: string; url: string }[];
    expect(items[0]).toMatchObject({
      "@type": "ListItem",
      position: 1,
      name: "TSLAx / TSLA · Meteora DLMM · Solana",
      url: "https://sofinancelab.xyz/pools/tsla-tslax-meteora",
    });
    expect(publicPoolsItemListJsonLd(null)).toBeNull();
  });

  it("uses the neutral Liquidity pools list name, not same-stock wording", () => {
    expect(PUBLIC_POOLS_H1).toBe("Liquidity pools");
    expect(PUBLIC_POOLS_H1).not.toMatch(/same-stock/i);
    expect(publicPoolsItemListJsonLd(snapshot)?.name).toBe(PUBLIC_POOLS_H1);
  });

  it("keeps the 7-day window and 'Fees not guaranteed' in the description, without banned copy", () => {
    const text = `${PUBLIC_POOLS_INTRO}\n${JSON.stringify(publicPoolsItemListJsonLd(snapshot))}`;
    expect(text).toContain("Fees not guaranteed");
    expect(text).toContain("past 7 days");
    expect(text.replaceAll("Fees not guaranteed", "")).not.toMatch(/guaranteed|\byield\b|\bearn\b|backtest|auto-rebalance/i);
    expect(text).not.toContain(PUBLIC_POOLS_APR_COLUMN);
  });
});
