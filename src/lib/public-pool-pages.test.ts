import { describe, expect, it } from "vitest";
import { HIGHEST_RANGE_APR_7D_HELP } from "@/lib/apr-labels/copy";
import type { HomepagePool, HomepagePoolsSnapshot } from "@/lib/homepage-pools";
import { HSOL_MINT, NATIVE_SOL_MINT, USDC_MINT, USDT_MINT } from "@/lib/rwa-allowlist";
import { PUBLIC_POOLS_H1, publicPoolRows } from "@/lib/public-pools-table";
import {
  PUBLIC_POOL_APR_LABEL,
  assignPublicPoolSlugs,
  findPublicPoolPageModel,
  listPublicPoolPageModels,
  poolSitemapEntries,
  publicDexSlug,
  publicPoolJsonLd,
  publicPoolMetadata,
  publicPoolDetailHrefs,
  publicPoolPageModel,
  publicPoolPairBase,
} from "./public-pool-pages";
import { poolPairLabel } from "./pool-names";

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

describe("public pool slugs", () => {
  it("uses alphabetically sorted symbol tokens (tsla-tslax, nvda-nvdaon)", () => {
    expect(publicPoolPairBase({ symbolA: "TSLAx", symbolB: "TSLA" })).toBe("tsla-tslax");
    expect(publicPoolPairBase({ symbolA: "TSLA", symbolB: "TSLAx" })).toBe("tsla-tslax");
    expect(publicPoolPairBase({ symbolA: "NVDA", symbolB: "NVDAon" })).toBe("nvda-nvdaon");
    expect(publicPoolPairBase({ symbolA: "SOL", symbolB: "hSOL" })).toBe("sol-hsol");
    expect(publicPoolPairBase({ symbolA: "hSOL", symbolB: "SOL" })).toBe("sol-hsol");
    expect(publicPoolPairBase({ symbolA: "WSOL", symbolB: "hSOL" })).toBe("sol-hsol");
    expect(publicDexSlug("raydium-clmm")).toBe("raydium");
    expect(publicDexSlug("meteora-dlmm")).toBe("meteora");
    expect(publicDexSlug("uniswap-v4-rhc")).toBe("uniswap");
  });

  it("gives the unsuffixed slug to the unique highest-priority DEX and suffixes the others", () => {
    const ray = pool({ key: "solana:tsla-raydium", protocol: "raydium-clmm", poolAddress: "tsla-raydium", symbolA: "TSLAx", symbolB: "TSLA" });
    const met = pool({ key: "solana:tsla-meteora", protocol: "meteora-dlmm", poolAddress: "tsla-meteora", symbolA: "TSLAx", symbolB: "TSLA" });
    const nvda = pool({ key: "robinhood:0xnvda", chain: "robinhood", protocol: "uniswap-v4-rhc", poolAddress: "0xnvda", symbolA: "NVDA", symbolB: "NVDAon", feeTierBps: null });
    const slugs = assignPublicPoolSlugs([ray, met, nvda]);
    expect(slugs.get(ray.key)).toBe("tsla-tslax");
    expect(slugs.get(met.key)).toBe("tsla-tslax-meteora");
    expect(slugs.get(nvda.key)).toBe("nvda-nvdaon");
    expect(new Set(slugs.values()).size).toBe(3);
  });

  it("is stable when APR ranking would swap which pool is listed first", () => {
    const ray = pool({ key: "solana:tsla-raydium", protocol: "raydium-clmm", poolAddress: "AddrRay", symbolA: "TSLAx", symbolB: "TSLA", tvlUsd: 10_000 });
    const met = pool({ key: "solana:tsla-meteora", protocol: "meteora-dlmm", poolAddress: "AddrMet", symbolA: "TSLAx", symbolB: "TSLA", tvlUsd: 90_000 });
    const forward = assignPublicPoolSlugs([ray, met]);
    const reverse = assignPublicPoolSlugs([met, ray]);
    expect(Object.fromEntries(forward)).toEqual(Object.fromEntries(reverse));
    expect(forward.get(ray.key)).toBe("tsla-tslax");
    expect(forward.get(met.key)).toBe("tsla-tslax-meteora");
  });

  it("does not give the unsuffixed slug away when the preferred DEX has two fee tiers", () => {
    const ray25 = pool({ key: "solana:tsla-ray-25", protocol: "raydium-clmm", poolAddress: "ray25", symbolA: "TSLAx", symbolB: "TSLA", feeTierBps: 25 });
    const ray100 = pool({ key: "solana:tsla-ray-100", protocol: "raydium-clmm", poolAddress: "ray100", symbolA: "TSLAx", symbolB: "TSLA", feeTierBps: 100 });
    const met = pool({ key: "solana:tsla-met", protocol: "meteora-dlmm", poolAddress: "met", symbolA: "TSLAx", symbolB: "TSLA" });
    const slugs = assignPublicPoolSlugs([ray25, ray100, met]);
    expect(slugs.get(ray25.key)).toBe("tsla-tslax-raydium-25bps");
    expect(slugs.get(ray100.key)).toBe("tsla-tslax-raydium-100bps");
    expect(slugs.get(met.key)).toBe("tsla-tslax-meteora");
    expect([...slugs.values()]).not.toContain("tsla-tslax");
    expect(new Set(slugs.values()).size).toBe(3);
  });
});

describe("public pool page models", () => {
  const ray = pool({ key: "solana:tsla-raydium", protocol: "raydium-clmm", poolAddress: "tsla-raydium", symbolA: "TSLAx", symbolB: "TSLA" });
  const met = pool({ key: "solana:tsla-meteora", protocol: "meteora-dlmm", poolAddress: "tsla-meteora", symbolA: "TSLAx", symbolB: "TSLA" });
  const snapshot: HomepagePoolsSnapshot = {
    pools: [ray, met],
    apr7d: { [ray.key]: 10.5, [met.key]: 12 },
    updated: [],
  };

  it("looks up a page by slug and returns null for an unknown slug", () => {
    const page = findPublicPoolPageModel(snapshot, "tsla-tslax");
    expect(page?.title).toBe("TSLAx / TSLA pool on Raydium CLMM");
    expect(page?.path).toBe("/pools/tsla-tslax");
    expect(page?.dex).toBe("Raydium CLMM");
    expect(page?.apr7d).toBe("10.50%");
    expect(page?.openInAppHref).toBe("/pools?openPool=tsla-raydium");
    expect(findPublicPoolPageModel(snapshot, "not-a-pool")).toBeNull();
    expect(findPublicPoolPageModel(null, "tsla-tslax")).toBeNull();
  });

  it("emits sitemap entries for every pool slug", () => {
    const entries = poolSitemapEntries(snapshot, "2026-11-20T00:00:00.000Z");
    expect(entries.map((entry) => entry.path).sort()).toEqual(["/pools/tsla-tslax", "/pools/tsla-tslax-meteora"]);
    expect(entries.every((entry) => entry.changeFrequency === "daily" && entry.lastModified === "2026-11-20T00:00:00.000Z")).toBe(true);
    expect(poolSitemapEntries(null, "2026-11-20T00:00:00.000Z")).toEqual([]);
  });

  it("builds unique metadata, breadcrumbs, and copy that uses 7d APR once", () => {
    const page = findPublicPoolPageModel(snapshot, "tsla-tslax-meteora")!;
    expect(poolPairLabel(page.pool, " / ")).toBe("TSLAx / TSLA");
    expect(page.pairLabel).toBe("TSLAx / TSLA");
    expect(page.metaTitle).toBe("TSLAx / TSLA pool on Meteora DLMM, 25 bps (Solana)");
    expect(page.metaDescription.length).toBeLessThanOrEqual(155);
    expect(page.metaDescription).toContain("Fees not guaranteed");
    expect(page.aprHelp).toBe(HIGHEST_RANGE_APR_7D_HELP);
    const metadata = publicPoolMetadata(page);
    expect(metadata.alternates?.canonical).toBe("/pools/tsla-tslax-meteora");
    expect(metadata.description).toBe(page.metaDescription);
    const json = publicPoolJsonLd(page);
    const graph = json["@graph"] as { "@type": string; itemListElement?: { name: string; item: string }[] }[];
    const types = graph.map((node) => node["@type"]);
    expect(types).toEqual(["WebPage", "BreadcrumbList"]);
    const crumbs = graph.find((node) => node["@type"] === "BreadcrumbList")?.itemListElement ?? [];
    expect(crumbs[0]?.item).toBe("https://sofinancelab.xyz");
    expect(crumbs[1]).toMatchObject({ name: PUBLIC_POOLS_H1, item: "https://sofinancelab.xyz/pools" });
    expect(crumbs[2]).toMatchObject({
      name: page.title,
      item: "https://sofinancelab.xyz/pools/tsla-tslax-meteora",
    });
    const blob = `${page.title}\n${page.metaDescription}\n${JSON.stringify(json)}`;
    // metadata may mention the 7-day window without using the "7d APR" phrase
    expect(blob).not.toContain(PUBLIC_POOL_APR_LABEL);
    expect(listPublicPoolPageModels(snapshot)).toHaveLength(2);
  });

  it("does not list or look up the USDC/USDT pool, and leaves stock slugs in the sitemap", () => {
    const stable = pool({
      key: "solana:usdc-usdt",
      protocol: "raydium-clmm",
      poolAddress: "usdc-usdt-pool",
      symbolA: "USDC",
      symbolB: "USDT",
      mintA: USDC_MINT,
      mintB: USDT_MINT,
    });
    const withStable: HomepagePoolsSnapshot = {
      pools: [...snapshot.pools, stable],
      apr7d: { ...snapshot.apr7d, [stable.key]: 40 },
      updated: [],
    };
    expect(findPublicPoolPageModel(withStable, "usdc-usdt")).toBeNull();
    expect(listPublicPoolPageModels(withStable).map((page) => page.slug).sort()).toEqual(["tsla-tslax", "tsla-tslax-meteora"]);
    expect(poolSitemapEntries(withStable, "2026-11-20T00:00:00.000Z").map((entry) => entry.path)).not.toContain("/pools/usdc-usdt");
    expect(poolSitemapEntries(withStable, "2026-11-20T00:00:00.000Z").map((entry) => entry.path).sort()).toEqual([
      "/pools/tsla-tslax",
      "/pools/tsla-tslax-meteora",
    ]);
    expect(publicPoolDetailHrefs(withStable)).toEqual({
      [ray.key]: "/pools/tsla-tslax",
      [met.key]: "/pools/tsla-tslax-meteora",
    });
    expect(publicPoolDetailHrefs(withStable)[stable.key]).toBeUndefined();
    expect(publicPoolDetailHrefs(null)).toEqual({});
  });

  it("shows the same 7d APR as the SSR table for a pool in the snapshot, and — only when that pool has no 7d value", () => {
    const sndk = pool({
      key: "solana:sndk-sndkx",
      protocol: "raydium-clmm",
      poolAddress: "sndk-pool",
      symbolA: "SNDKx",
      symbolB: "SNDK",
    });
    const antRay = pool({
      key: "solana:ant-antx",
      protocol: "raydium-clmm",
      poolAddress: "ant-raydium",
      symbolA: "ANTx",
      symbolB: "ANT",
    });
    const antMeteora = pool({
      key: "solana:ant-antx-meteora",
      protocol: "meteora-dlmm",
      poolAddress: "ant-meteora",
      symbolA: "ANT",
      symbolB: "ANTx",
    });
    const withApr: HomepagePoolsSnapshot = {
      pools: [...snapshot.pools, sndk, antRay, antMeteora],
      apr7d: { ...snapshot.apr7d, [sndk.key]: 81.28, [antRay.key]: 13.68 },
      updated: [],
    };
    const rows = publicPoolRows(withApr);
    const sndkRow = rows.find((row) => row.href === "/pools/sndk-sndkx");
    const antRow = rows.find((row) => row.href === "/pools/ant-antx-meteora");
    const antRayRow = rows.find((row) => row.href === "/pools/ant-antx");
    const sndkPage = findPublicPoolPageModel(withApr, "sndk-sndkx");
    const antPage = findPublicPoolPageModel(withApr, "ant-antx-meteora");
    const antRayPage = findPublicPoolPageModel(withApr, "ant-antx");
    expect(antRayRow?.apr7d).toBe("13.68%");
    expect(antRayPage?.apr7d).toBe("13.68%");
    expect(sndkRow?.apr7d).toBe("81.28%");
    expect(sndkPage?.apr7d).toBe("81.28%");
    expect(sndkPage?.apr7d).toBe(sndkRow?.apr7d);
    expect(antRow?.apr7d).toBe("—");
    expect(antPage?.apr7d).toBe("—");
    expect(antPage?.apr7d).toBe(antRow?.apr7d);
  });

  it("includes the fee in the document title so same-pair fee tiers stay unique", () => {
    const one = pool({ key: "solana:spcx-1", protocol: "raydium-clmm", poolAddress: "spcx-1", symbolA: "SPCXx", symbolB: "SPCX", feeTierBps: 1 });
    const five = pool({ key: "solana:spcx-5", protocol: "raydium-clmm", poolAddress: "spcx-5", symbolA: "SPCXx", symbolB: "SPCX", feeTierBps: 5 });
    const onePage = publicPoolPageModel(one, 10, "spcx-spcxx-raydium-1bps");
    const fivePage = publicPoolPageModel(five, 11, "spcx-spcxx-raydium-5bps");
    expect(onePage.metaTitle).toBe("SPCXx / SPCX pool on Raydium CLMM, 1 bps (Solana)");
    expect(fivePage.metaTitle).toBe("SPCXx / SPCX pool on Raydium CLMM, 5 bps (Solana)");
    expect(onePage.metaTitle).not.toBe(fivePage.metaTitle);
    expect(onePage.feeTier).toBe("1 bps");
    expect(fivePage.feeTier).toBe("5 bps");
  });

  it("omits the fee from the document title when the fee tier is missing", () => {
    const rhc = pool({
      key: "robinhood:0xspcx",
      chain: "robinhood",
      protocol: "uniswap-v4-rhc",
      poolAddress: "0xspcx",
      symbolA: "SPCX",
      symbolB: "SPCXon",
      pairLabel: "SPCX/SPCXon",
      feeTierBps: null,
    });
    const page = publicPoolPageModel(rhc, 9, "spcx-spcxon");
    expect(page.pairLabel).toBe("SPCX / SPCXon");
    expect(page.title).toBe("SPCX / SPCXon pool on Uniswap v4");
    expect(page.metaTitle).toBe("SPCX / SPCXon pool on Uniswap v4 (Robinhood Chain)");
    expect(page.feeTier).toBe("—");
    expect(page.metaDescription.length).toBeLessThanOrEqual(155);
  });

  it("uses pairLabel order even when symbolA/symbolB are flipped, and matches the SSR table card", () => {
    const flipped = pool({
      key: "solana:tsla-flipped",
      protocol: "raydium-clmm",
      poolAddress: "tsla-flipped",
      symbolA: "TSLA",
      symbolB: "TSLAx",
      pairLabel: "TSLAx/TSLA",
      feeTierBps: 5,
    });
    const snap: HomepagePoolsSnapshot = { pools: [flipped], apr7d: { [flipped.key]: 8 }, updated: [] };
    const page = findPublicPoolPageModel(snap, "tsla-tslax")!;
    const row = publicPoolRows(snap)[0];
    expect(page.pairLabel).toBe("TSLAx / TSLA");
    expect(row?.pairLabel).toBe(page.pairLabel);
    expect(page.feeTier).toBe("5 bps");
    expect(row?.feeTier).toBe(page.feeTier);
  });

  it("keeps every pool-page pairLabel equal to the SSR table card, with descriptions at most 155 characters", () => {
    const pages = listPublicPoolPageModels(snapshot);
    const rows = publicPoolRows(snapshot);
    expect(pages.length).toBe(rows.length);
    for (const page of pages) {
      const row = rows.find((item) => item.key === page.pool.key);
      expect(row?.pairLabel, page.slug).toBe(page.pairLabel);
      expect(page.metaDescription.length, page.metaDescription).toBeLessThanOrEqual(155);
    }
  });
});

describe("SOL / hSOL public SEO pages", () => {
  const ray = pool({
    key: "solana:sol-hsol-raydium",
    protocol: "raydium-clmm",
    poolAddress: "51V5bAPGaz3vj4SiJeoLGNzAQNxGr4Vps8gSBKmSZx71",
    symbolA: "SOL",
    symbolB: "hSOL",
    mintA: NATIVE_SOL_MINT,
    mintB: HSOL_MINT,
    feeTierBps: 1,
  });
  const met = pool({
    key: "solana:sol-hsol-meteora",
    protocol: "meteora-dlmm",
    poolAddress: "6a7EnjAoiRBbminKkWPdytMFFf5ogjLutqwpvAVyZ89j",
    symbolA: "hSOL",
    symbolB: "SOL",
    mintA: HSOL_MINT,
    mintB: NATIVE_SOL_MINT,
    feeTierBps: 1,
  });
  const stable = pool({
    key: "solana:usdc-usdt",
    protocol: "raydium-clmm",
    poolAddress: "usdc-usdt-pool",
    symbolA: "USDC",
    symbolB: "USDT",
    mintA: USDC_MINT,
    mintB: USDT_MINT,
  });
  const snap: HomepagePoolsSnapshot = {
    pools: [ray, met, stable],
    apr7d: { [ray.key]: 20, [met.key]: 15 },
    updated: [],
  };

  it("publishes /pools/sol-hsol for Raydium and suffixes Meteora, and keeps USDC/USDT off the public pages", () => {
    expect(assignPublicPoolSlugs([ray, met]).get(ray.key)).toBe("sol-hsol");
    expect(assignPublicPoolSlugs([ray, met]).get(met.key)).toBe("sol-hsol-meteora");
    const page = findPublicPoolPageModel(snap, "sol-hsol")!;
    expect(page.path).toBe("/pools/sol-hsol");
    expect(page.pairLabel).toBe("SOL / hSOL");
    expect(findPublicPoolPageModel(snap, "sol-hsol-meteora")?.path).toBe("/pools/sol-hsol-meteora");
    expect(findPublicPoolPageModel(snap, "hsol-sol")).toBeNull();
    expect(findPublicPoolPageModel(snap, "usdc-usdt")).toBeNull();
    expect(poolSitemapEntries(snap, "2026-11-26T00:00:00.000Z").map((entry) => entry.path).sort()).toEqual([
      "/pools/sol-hsol",
      "/pools/sol-hsol-meteora",
    ]);
  });

  it("uses LST copy that avoids banned words and the same-stock phrasing", () => {
    const page = findPublicPoolPageModel(snap, "sol-hsol")!;
    expect(page.metaDescription.length).toBeLessThanOrEqual(155);
    expect(page.metaDescription).toContain("liquidity pool");
    expect(page.metaDescription).not.toContain("same-stock");
    expect(page.metaDescription).not.toMatch(/backtest|\bearn\b|\byield\b|\bAPY\b|guaranteed|open source/i);
  });
});
