import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { describe, expect, it } from "vitest";
import RwaPairsPage from "./page";

function poolsProps(tree: ReactElement) {
  const children = (tree.props as { children?: ReactNode }).children;
  const child = Children.toArray(children).find(
    (node) => isValidElement(node) && typeof node.props === "object" && node.props !== null && "rhcSigningEnabled" in node.props,
  );
  if (!isValidElement(child)) throw new Error("expected PoolsPage");
  return child.props as { flags: unknown; rhcSigningEnabled: unknown; deepLinkPool?: string };
}

describe("/app/rwa-pairs page", () => {
  it("silently ignores a ?risk= param (the Risk filter was removed): same props as no param, no error", async () => {
    const plain = await RwaPairsPage({ searchParams: Promise.resolve({}) });
    for (const risk of ["freeze", "token-2022", "none", "pool-warning", "garbage", ["freeze", "none"]]) {
      const withRisk = await RwaPairsPage({ searchParams: Promise.resolve({ risk }) });
      expect(poolsProps(withRisk)).toEqual(poolsProps(plain));
    }
    const deepLink = await RwaPairsPage({ searchParams: Promise.resolve({ risk: "freeze", openPool: "abc" }) });
    expect(poolsProps(deepLink)).toEqual({ ...poolsProps(plain), deepLinkPool: "abc" });
  });
});
