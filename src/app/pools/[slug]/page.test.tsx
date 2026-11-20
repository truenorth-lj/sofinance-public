import { type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HomepagePool, HomepagePoolsSnapshot } from "@/lib/homepage-pools";
import { USDC_MINT, USDT_MINT } from "@/lib/rwa-allowlist";

const { notFound, loadHomepagePoolsSnapshot } = vi.hoisted(() => ({
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
  loadHomepagePoolsSnapshot: vi.fn(),
}));

vi.mock("next/navigation", () => ({ notFound, usePathname: () => "/pools/tsla-tslax" }));
vi.mock("@/lib/homepage-pools-snapshot", () => ({ loadHomepagePoolsSnapshot }));

import PublicPoolSlugPage, { generateMetadata, generateStaticParams } from "./page";

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
    pool({ key: "solana:tsla-raydium", protocol: "raydium-clmm", poolAddress: "tsla-raydium", symbolA: "TSLAx", symbolB: "TSLA" }),
    pool({ key: "solana:tsla-meteora", protocol: "meteora-dlmm", poolAddress: "tsla-meteora", symbolA: "TSLAx", symbolB: "TSLA" }),
    pool({ key: "solana:usdc-usdt", protocol: "raydium-clmm", poolAddress: "usdc-usdt-pool", symbolA: "USDC", symbolB: "USDT", mintA: USDC_MINT, mintB: USDT_MINT }),
  ],
  apr7d: { "solana:tsla-raydium": 10, "solana:tsla-meteora": 11, "solana:usdc-usdt": 40 },
  updated: [],
};

describe("/pools/[slug]", () => {
  beforeEach(() => {
    notFound.mockClear();
    loadHomepagePoolsSnapshot.mockReset();
    loadHomepagePoolsSnapshot.mockResolvedValue(snapshot);
    vi.stubEnv("NEXT_PUBLIC_REOWN_PROJECT_ID", "test-reown-id");
  });

  it("prebuilds the snapshot slugs and 404s an unknown slug", async () => {
    const params = await generateStaticParams();
    expect(params.map((row) => row.slug).sort()).toEqual(["tsla-tslax", "tsla-tslax-meteora"]);
    expect(params.map((row) => row.slug)).not.toContain("usdc-usdt");
    await expect(PublicPoolSlugPage({ params: Promise.resolve({ slug: "not-a-pool" }) })).rejects.toThrow("NEXT_NOT_FOUND");
    expect(notFound).toHaveBeenCalled();
    notFound.mockClear();
    await expect(PublicPoolSlugPage({ params: Promise.resolve({ slug: "usdc-usdt" }) })).rejects.toThrow("NEXT_NOT_FOUND");
    expect(notFound).toHaveBeenCalled();
    await expect(generateMetadata({ params: Promise.resolve({ slug: "usdc-usdt" }) })).resolves.toEqual({ title: "Pool not found" });
    await expect(generateMetadata({ params: Promise.resolve({ slug: "not-a-pool" }) })).resolves.toEqual({ title: "Pool not found" });
  });

  it("server-renders unique metadata, H1, JSON-LD breadcrumbs and facts under a Reown id", async () => {
    const metadata = await generateMetadata({ params: Promise.resolve({ slug: "tsla-tslax" }) });
    expect(metadata.alternates?.canonical).toBe("/pools/tsla-tslax");
    expect(String(metadata.description)).toContain("Fees not guaranteed");
    const tree = await PublicPoolSlugPage({ params: Promise.resolve({ slug: "tsla-tslax" }) }) as ReactElement;
    const html = renderToStaticMarkup(tree);
    expect(html).toContain("application/ld+json");
    expect(html).toContain("BreadcrumbList");
    expect(html).toContain("WebPage");
    expect(html).toContain("$TSLAx / $TSLA on Raydium CLMM");
    expect(html).toContain("7d APR");
    expect(html.split("7d APR")).toHaveLength(2);
    expect(html).toContain("10.00%");
    expect(html).not.toContain("<!--$!-->");
    expect(notFound).not.toHaveBeenCalled();
  });

  it("skips generateStaticParams when every 7d APR failed to load, so deploys do not prerender all dashes", async () => {
    loadHomepagePoolsSnapshot.mockResolvedValue({ ...snapshot, apr7d: {} });
    expect(await generateStaticParams()).toEqual([]);
    const html = renderToStaticMarkup(await PublicPoolSlugPage({ params: Promise.resolve({ slug: "tsla-tslax" }) }) as ReactElement);
    expect(html).toContain("7d APR");
    expect(html).toContain("—");
    expect(html).not.toContain("10.00%");
  });

  it("still shows — for a genuinely missing 7d value and still prerenders the other slugs", async () => {
    loadHomepagePoolsSnapshot.mockResolvedValue({
      ...snapshot,
      apr7d: { "solana:tsla-meteora": 11 },
    });
    const params = await generateStaticParams();
    expect(params.map((row) => row.slug).sort()).toEqual(["tsla-tslax", "tsla-tslax-meteora"]);
    const missing = renderToStaticMarkup(await PublicPoolSlugPage({ params: Promise.resolve({ slug: "tsla-tslax" }) }) as ReactElement);
    const ready = renderToStaticMarkup(await PublicPoolSlugPage({ params: Promise.resolve({ slug: "tsla-tslax-meteora" }) }) as ReactElement);
    expect(missing).toContain("—");
    expect(missing).not.toContain("10.00%");
    expect(ready).toContain("11.00%");
  });
});
