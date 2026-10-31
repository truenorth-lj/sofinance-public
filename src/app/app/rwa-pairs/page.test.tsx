import { describe, expect, it } from "vitest";
import RwaPairsPage from "./page";

describe("/app/rwa-pairs page", () => {
  it("silently ignores a ?risk= param (the Risk filter was removed): same props as no param, no error", async () => {
    const plain = await RwaPairsPage({ searchParams: Promise.resolve({}) });
    for (const risk of ["freeze", "token-2022", "none", "pool-warning", "garbage", ["freeze", "none"]]) {
      const withRisk = await RwaPairsPage({ searchParams: Promise.resolve({ risk }) });
      expect(withRisk.props).toEqual(plain.props);
    }
    const deepLink = await RwaPairsPage({ searchParams: Promise.resolve({ risk: "freeze", openPool: "abc" }) });
    expect(deepLink.props).toEqual({ ...plain.props, deepLinkPool: "abc" });
  });
});
