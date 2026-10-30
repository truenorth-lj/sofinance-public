import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { proxy } from "../../proxy";
import { APP_POOLS_PATH, RHC_DEEP_LINK, rwaPairsRedirect, unifiedAppRedirect } from "./deep-link";

afterEach(() => { vi.unstubAllEnvs(); });

describe("/app/rhc → /app deep link", () => {
  it("points at the allowlisted Robinhood Chain pool", () => {
    expect(RHC_DEEP_LINK).toBe("/app?openPool=0x4f54c74021e4139bbc4c7bc924346c921975136ea120cf118a93c43b50bdbd3c");
    expect(unifiedAppRedirect("/app/rhc")).toBe(RHC_DEEP_LINK);
    expect(unifiedAppRedirect("/app")).toBeNull();
  });
  it("is a real 307 from the proxy in production", () => {
    vi.stubEnv("VERCEL_ENV", "production");
    const res = proxy(new NextRequest("https://sofinancelab.xyz/app/rhc", { headers: { host: "sofinancelab.xyz" } }));
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get("location")!).pathname + new URL(res.headers.get("location")!).search).toBe(RHC_DEEP_LINK);
  });
});

describe("/app/rwa-pairs (retired) → /app#pools", () => {
  it("maps the old open-position deep link to ?openPool= and keeps campaign params", () => {
    expect(rwaPairsRedirect("")).toBe("/app#pools");
    expect(rwaPairsRedirect("?pool=Pool111&open=1")).toBe("/app?openPool=Pool111#pools");
    expect(rwaPairsRedirect("?pool=Pool111")).toBe("/app#pools");
    expect(rwaPairsRedirect("?ref=x-article&utm_source=x&other=1")).toBe("/app?ref=x-article&utm_source=x#pools");
    expect(unifiedAppRedirect("/app/rwa-pairs", "?pool=P&open=1&ref=r")).toBe("/app?openPool=P&ref=r#pools");
    expect(unifiedAppRedirect("/app/rwa-pairs/")).toBe("/app#pools");
    expect(APP_POOLS_PATH).toBe("/app#pools");
  });
  it("is a real 307 from the proxy (fragment included), also for /rwa-pairs' second hop", () => {
    vi.stubEnv("VERCEL_ENV", "production");
    const res = proxy(new NextRequest("https://sofinancelab.xyz/app/rwa-pairs?pool=Pool111&open=1&ref=x-article", { headers: { host: "sofinancelab.xyz" } }));
    expect(res.status).toBe(307);
    const location = new URL(res.headers.get("location")!);
    expect(location.pathname + location.search + location.hash).toBe("/app?openPool=Pool111&ref=x-article#pools");
  });
});
