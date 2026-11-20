import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { type ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/homepage-pools-snapshot", () => ({
  loadHomepagePoolsSnapshot: vi.fn(async () => null),
}));

import { PoolsPage } from "@/components/unified-pools/pools-page";
import RwaPairsPage from "./page";

function poolsPageProps(node: ReactElement) {
  const children = (node.props as { children?: unknown }).children;
  const list = Array.isArray(children) ? children : [children];
  const page = list.find((child) => child && typeof child === "object" && "type" in child && child.type === PoolsPage) as ReactElement | undefined;
  if (!page) throw new Error("PoolsPage not found");
  return page.props as Record<string, unknown>;
}

describe("/app/rwa-pairs page", () => {
  it("silently ignores a ?risk= param (the Risk filter was removed): same props as no param, no error", async () => {
    const plain = poolsPageProps(await RwaPairsPage({ searchParams: Promise.resolve({}) }) as ReactElement);
    for (const risk of ["freeze", "token-2022", "none", "pool-warning", "garbage", ["freeze", "none"]]) {
      const withRisk = poolsPageProps(await RwaPairsPage({ searchParams: Promise.resolve({ risk }) }) as ReactElement);
      expect(withRisk).toEqual(plain);
    }
    const deepLink = poolsPageProps(await RwaPairsPage({ searchParams: Promise.resolve({ risk: "freeze", openPool: "abc" }) }) as ReactElement);
    expect(deepLink).toEqual({ ...plain, deepLinkPool: "abc" });
  });

  it("passes ?q= through as initialQuery so the list search is prefilled, including with a deep link", async () => {
    const plain = poolsPageProps(await RwaPairsPage({ searchParams: Promise.resolve({}) }) as ReactElement);
    const withQuery = poolsPageProps(await RwaPairsPage({ searchParams: Promise.resolve({ q: "tesla" }) }) as ReactElement);
    expect(withQuery).toEqual({ ...plain, initialQuery: "tesla" });
    const both = poolsPageProps(await RwaPairsPage({ searchParams: Promise.resolve({ q: "spcx", openPool: "abc" }) }) as ReactElement);
    expect(both).toEqual({ ...plain, initialQuery: "spcx", deepLinkPool: "abc" });
  });

  it("parses ?openPool=, ?calc=, and the legacy ?pool=&open=1 open link", async () => {
    const plain = poolsPageProps(await RwaPairsPage({ searchParams: Promise.resolve({}) }) as ReactElement);
    expect(poolsPageProps(await RwaPairsPage({ searchParams: Promise.resolve({ openPool: "abc" }) }) as ReactElement))
      .toEqual({ ...plain, deepLinkPool: "abc" });
    expect(poolsPageProps(await RwaPairsPage({ searchParams: Promise.resolve({ pool: "legacy", open: "1" }) }) as ReactElement))
      .toEqual({ ...plain, deepLinkPool: "legacy" });
    expect(poolsPageProps(await RwaPairsPage({ searchParams: Promise.resolve({ pool: "legacy" }) }) as ReactElement))
      .toEqual(plain);
    expect(poolsPageProps(await RwaPairsPage({ searchParams: Promise.resolve({ openPool: "abc", pool: "legacy", open: "1" }) }) as ReactElement))
      .toEqual({ ...plain, deepLinkPool: "abc" });
    expect(poolsPageProps(await RwaPairsPage({ searchParams: Promise.resolve({ calc: "xyz" }) }) as ReactElement))
      .toEqual({ ...plain, deepLinkCalc: "xyz" });
    expect(poolsPageProps(await RwaPairsPage({ searchParams: Promise.resolve({ calc: "xyz", openPool: "abc" }) }) as ReactElement))
      .toEqual({ ...plain, deepLinkCalc: "xyz", deepLinkPool: "abc" });
  });

  it("uses a single Pools h1 and no InkHero; the crawler table is an h2", () => {
    const page = readFileSync(resolve("src/components/unified-pools/pools-page.tsx"), "utf8");
    expect(page).not.toContain("InkHero");
    expect(page).toContain("POOLS_PAGE_TITLE");
    expect(page).toContain("<h1");
    const table = readFileSync(resolve("src/components/public-pools-table.tsx"), "utf8");
    expect(table).not.toMatch(/<h1\b/);
    expect(table).toContain("<h2");
  });
});
