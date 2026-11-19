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
});
