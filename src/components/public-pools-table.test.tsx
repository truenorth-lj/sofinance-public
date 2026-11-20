import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { HomepagePool, HomepagePoolsSnapshot } from "@/lib/homepage-pools";
import { USDC_MINT, USDT_MINT } from "@/lib/rwa-allowlist";
import { PUBLIC_POOLS_APR_COLUMN, PUBLIC_POOLS_SSR_HEADING } from "@/lib/public-pools-table";
import { PublicPoolsTable } from "./public-pools-table";

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

const snapshot: HomepagePoolsSnapshot = {
  pools: [
    pool({ key: "solana:tsla-raydium", protocol: "raydium-clmm", poolAddress: "tsla-raydium", symbolA: "TSLAx", symbolB: "TSLA", tvlUsd: 80_000 }),
    pool({ key: "solana:tsla-meteora", protocol: "meteora-dlmm", poolAddress: "tsla-meteora", symbolA: "TSLAx", symbolB: "TSLA", tvlUsd: 20_000 }),
    pool({ key: "robinhood:0xnvda", chain: "robinhood", protocol: "uniswap-v4-rhc", poolAddress: "0xnvda", symbolA: "NVDA", symbolB: "NVDAon", feeTierBps: null }),
    pool({ key: "solana:usdc-usdt", protocol: "raydium-clmm", poolAddress: "usdc-usdt", symbolA: "USDC", symbolB: "USDT", mintA: USDC_MINT, mintB: USDT_MINT, tvlUsd: 1_800_000 }),
  ],
  apr7d: { "solana:tsla-raydium": 10, "solana:tsla-meteora": 11, "robinhood:0xnvda": 8, "solana:usdc-usdt": 40 },
  updated: [],
};

const html = (node: HomepagePoolsSnapshot | null) => renderToStaticMarkup(createElement(PublicPoolsTable, { snapshot: node }));

describe("PublicPoolsTable (HTML without JS)", () => {
  it("renders an h2 (not h1), Meteora DLMM, TVL, 24h volume, and the 7-day window in static markup", () => {
    const markup = html(snapshot);
    expect(markup).toContain("<table");
    expect(markup).toContain('id="public-pools-heading"');
    expect(markup).toContain("<h2");
    expect(markup).not.toContain("<h1");
    expect(markup).toContain(PUBLIC_POOLS_SSR_HEADING);
    expect(markup).not.toMatch(/same-stock/i);
    expect(markup).toContain("Meteora DLMM");
    expect(markup).toContain("Raydium CLMM");
    expect(markup).toContain("Uniswap v4");
    expect(markup).toContain("TSLAx / TSLA");
    expect(markup).toContain("Robinhood Chain");
    expect(markup).toContain("24h volume");
    expect(markup).toContain("TVL");
    expect(markup).toContain("Fees not guaranteed");
    expect(markup).toContain("past 7 days");
    expect(markup).toContain("/learn");
    expect(markup).toContain("Open pool");
    expect(markup).toContain('href="/pools/tsla-tslax"');
    expect(markup).toContain('href="/pools/tsla-tslax-meteora"');
    expect(markup).toContain('href="/pools/nvda-nvdaon"');
    expect(markup).not.toContain("/pools?pool=");
    expect(markup).not.toContain("USDC");
    expect(markup).not.toContain("/pools/usdc-usdt");
  });

  it("uses the phrase 7d APR only once, and does not use banned copy", () => {
    const markup = html(snapshot);
    expect(markup.split(PUBLIC_POOLS_APR_COLUMN)).toHaveLength(2);
    expect(markup.replaceAll("Fees not guaranteed", "")).not.toMatch(/guaranteed|\byield\b|\bearn\b|backtest|auto-rebalance/i);
  });

  it("renders a fallback when the snapshot is missing, still with the heading and window copy", () => {
    const markup = html(null);
    expect(markup).toContain(PUBLIC_POOLS_SSR_HEADING);
    expect(markup).not.toContain("<h1");
    expect(markup).toContain("Fees not guaranteed");
    expect(markup).not.toContain("<table");
    expect(markup).toContain("temporarily unavailable");
  });
});
