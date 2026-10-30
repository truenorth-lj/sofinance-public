import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { proxy } from "../../proxy";
import { openPoolRedirect, RHC_DEEP_LINK, unifiedAppRedirect } from "./deep-link";

afterEach(() => { vi.unstubAllEnvs(); });

const RHC_POOL = "0x4f54c74021e4139bbc4c7bc924346c921975136ea120cf118a93c43b50bdbd3c";
const location = (res: Response) => { const url = new URL(res.headers.get("location")!); return url.pathname + url.search; };

describe("pool deep links → /app/rwa-pairs (the pools page)", () => {
  it("/app/rhc opens the allowlisted Robinhood Chain pool on the pools page", () => {
    expect(RHC_DEEP_LINK).toBe(`/app/rwa-pairs?openPool=${RHC_POOL}`);
    expect(unifiedAppRedirect("/app/rhc")).toBe(RHC_DEEP_LINK);
  });
  it("old /app?openPool= links move to the pools page; /app itself stays", () => {
    expect(unifiedAppRedirect("/app", `?openPool=${RHC_POOL}`)).toBe(RHC_DEEP_LINK);
    expect(unifiedAppRedirect("/app", "?openPool=poolone&view=performance")).toBe("/app/rwa-pairs?openPool=poolone");
    expect(unifiedAppRedirect("/app")).toBeNull();
    expect(unifiedAppRedirect("/app", "?view=performance&mint=abc")).toBeNull();
    expect(unifiedAppRedirect("/app/rwa-pairs", "?openPool=x")).toBeNull();
    expect(openPoolRedirect("  ")).toBeNull();
    expect(openPoolRedirect("a b")).toBe("/app/rwa-pairs?openPool=a%20b");
  });
  it.each([
    ["/app/rhc", RHC_DEEP_LINK],
    [`/app?openPool=${RHC_POOL}`, RHC_DEEP_LINK],
  ])("is a real 307 from the proxy in production (%s)", (path, target) => {
    vi.stubEnv("VERCEL_ENV", "production");
    const res = proxy(new NextRequest(`https://sofinancelab.xyz${path}`, { headers: { host: "sofinancelab.xyz" } }));
    expect(res.status).toBe(307);
    expect(location(res)).toBe(target);
  });
  it("leaves /app without openPool alone", () => {
    vi.stubEnv("VERCEL_ENV", "production");
    const res = proxy(new NextRequest("https://sofinancelab.xyz/app?view=performance", { headers: { host: "sofinancelab.xyz" } }));
    expect(res.headers.get("location")).toBeNull();
  });
});
