import { describe, expect, it } from "vitest";
import { HIGHEST_RANGE_APR_7D_HELP } from "@/lib/apr-labels/copy";
import type { HomepagePool, HomepagePoolsSnapshot } from "@/lib/homepage-pools";
import { USDC_MINT, USDT_MINT } from "@/lib/rwa-allowlist";
import { PUBLIC_POOLS_H1 } from "@/lib/public-pools-table";
import {
  PUBLIC_POOL_APR_LABEL,
  assignPublicPoolSlugs,
  findPublicPoolPageModel,
  listPublicPoolPageModels,
  poolSitemapEntries,
  publicDexSlug,
  publicPoolJsonLd,
  publicPoolMetadata,
  publicPoolPairBase,
  publicPoolPairLabel,
} from "./public-pool-pages";

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
    expect(page?.title).toBe("$TSLAx / $TSLA on Raydium CLMM");
    expect(page?.path).toBe("/pools/tsla-tslax");
    expect(page?.dex).toBe("Raydium CLMM");
    expect(page?.apr7d).toBe("10.50%");
    expect(page?.openInAppHref).toBe("/app/rwa-pairs?pool=tsla-raydium&open=1");
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
    expect(publicPoolPairLabel(page.pool)).toBe("$TSLAx / $TSLA");
    expect(page.metaDescription).toContain(HIGHEST_RANGE_APR_7D_HELP);
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
    expect(crumbs[1]).toMatchObject({ name: PUBLIC_POOLS_H1, item: "https://sofinancelab.xyz/app/rwa-pairs" });
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
  });
});
