import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ usePathname: () => "/pools/tsla-tslax" }));

import type { HomepagePool } from "@/lib/homepage-pools";
import { PUBLIC_POOL_APR_LABEL, publicPoolPageModel } from "@/lib/public-pool-pages";
import { PublicPoolPage } from "./public-pool-page";

const pool: HomepagePool = {
  key: "solana:tsla-raydium",
  chain: "solana",
  protocol: "raydium-clmm",
  poolAddress: "tsla-raydium",
  pairLabel: "TSLAx/TSLA",
  symbolA: "TSLAx",
  symbolB: "TSLA",
  nameA: "TSLAx",
  nameB: "TSLA",
  mintA: "TSLAx-mint",
  mintB: "TSLA-mint",
  feeTierBps: 25,
  tvlUsd: 80_000,
  volume24hUsd: 2_000,
  poolFeeApr24hPct: 12,
};

describe("PublicPoolPage (HTML without JS)", () => {
  const model = publicPoolPageModel(pool, 10.5, "tsla-tslax");
  const markup = renderToStaticMarkup(createElement(PublicPoolPage, { model }));

  it("renders an H1, factual stats, the 7-day window, and app/list links", () => {
    expect(markup).toContain("<h1");
    expect(markup).toContain("TSLAx / TSLA pool on Raydium CLMM");
    expect(markup).toContain("Solana");
    expect(markup).toContain("Raydium CLMM");
    expect(markup).toContain("25 bps");
    expect(markup).toContain("TVL");
    expect(markup).toContain("24h volume");
    expect(markup).toContain(PUBLIC_POOL_APR_LABEL);
    expect(markup).toContain("10.50%");
    expect(markup).toContain("Fees not guaranteed");
    expect(markup).toContain("past 7 days");
    expect(markup).toContain('href="/app/rwa-pairs?openPool=tsla-raydium"');
    expect(markup).toContain('href="/app/rwa-pairs"');
    expect(markup).toContain('href="/learn"');
    expect(markup).toMatch(/aria-label="Breadcrumb"/);
  });

  it("uses the phrase 7d APR only once and does not use banned copy", () => {
    expect(markup.split(PUBLIC_POOL_APR_LABEL)).toHaveLength(2);
    expect(markup.replaceAll("Fees not guaranteed", "")).not.toMatch(/guaranteed|\byield\b|\bearn\b|backtest|auto-rebalance/i);
  });


  it("uses chain · DEX · fee tier as the h1 subline and keeps aprHelp under the 7d APR fact", () => {
    expect(markup).toContain("Solana · Raydium CLMM · 25 bps fee tier");
    expect(markup).toContain('data-testid="apr-help"');
    const aprIdx = markup.indexOf(PUBLIC_POOL_APR_LABEL);
    const helpIdx = markup.indexOf('data-testid="apr-help"');
    expect(aprIdx).toBeGreaterThan(-1);
    expect(helpIdx).toBeGreaterThan(aprIdx);
  });


  it("still server-renders when a Reown project id is set", () => {
    vi.stubEnv("NEXT_PUBLIC_REOWN_PROJECT_ID", "test-reown-id");
    const html = renderToStaticMarkup(createElement(PublicPoolPage, { model }));
    expect(html).toContain("<h1");
    expect(html).toContain("Same-stock liquidity pools");
    expect(html).not.toContain("<!--$!-->");
    vi.unstubAllEnvs();
  });

  it("shows Open position and Calculate shares for a supported Solana pool, and drops the old text CTA", () => {
    expect(markup).toContain('aria-label="Open position in TSLAx / TSLA"');
    expect(markup).toContain('href="/app/rwa-pairs?openPool=tsla-raydium"');
    expect(markup).toContain('aria-label="Calculate shares for TSLAx / TSLA"');
    expect(markup).toContain('href="/app/rwa-pairs?calc=tsla-raydium"');
    expect(markup).toContain("Open position");
    expect(markup).toContain("Calculate shares");
    expect(markup).toContain("All pools");
    expect(markup).not.toContain("Open this pool in the app");
    expect(markup).not.toContain("All same-stock pools");
  });
});

describe("PublicPoolPage calculator support", () => {
  it("omits Calculate shares on a Robinhood Chain pool page and keeps Open position", () => {
    const rhc: HomepagePool = {
      key: "robinhood:0xnvda",
      chain: "robinhood",
      protocol: "uniswap-v4-rhc",
      poolAddress: "0xnvda",
      pairLabel: "NVDA/NVDAon",
      symbolA: "NVDA",
      symbolB: "NVDAon",
      nameA: "NVDA",
      nameB: "NVDAon",
      mintA: "0xa",
      mintB: "0xb",
      feeTierBps: null,
      tvlUsd: 80_000,
      volume24hUsd: 2_000,
      poolFeeApr24hPct: 12,
    };
    const html = renderToStaticMarkup(createElement(PublicPoolPage, { model: publicPoolPageModel(rhc, 8.2, "nvda-nvdaon") }));
    expect(html).toContain('aria-label="Open position in NVDA / NVDAon"');
    expect(html).toContain('href="/app/rwa-pairs?openPool=0xnvda"');
    expect(html).toContain("Open position");
    expect(html).not.toContain("Calculate shares");
    expect(html).not.toContain("?calc=");
  });
});
