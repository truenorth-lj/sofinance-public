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
  it("old /app?openPool= links move to the pools page; /app itself moves to Portfolio", () => {
    expect(unifiedAppRedirect("/app", `?openPool=${RHC_POOL}`)).toBe(RHC_DEEP_LINK);
    expect(unifiedAppRedirect("/app", "?openPool=poolone&view=performance")).toBe("/app/rwa-pairs?openPool=poolone");
    expect(unifiedAppRedirect("/app")).toBe("/app/portfolio");
    expect(unifiedAppRedirect("/app", "?view=performance&mint=abc")).toBe("/app/portfolio?view=performance&mint=abc");
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
});

describe("/app → /app/portfolio (Positions was renamed Portfolio)", () => {
  const go = (path: string) => {
    vi.stubEnv("VERCEL_ENV", "production");
    return proxy(new NextRequest(`https://sofinancelab.xyz${path}`, { headers: { host: "sofinancelab.xyz" } }));
  };
  it("redirects the old URL to Portfolio with a real 307", () => {
    const res = go("/app");
    expect(res.status).toBe(307);
    expect(location(res)).toBe("/app/portfolio");
  });
  it.each([
    "?position=raydium-clmm:9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin&view=performance",
    "?position=meteora-dlmm:Pos111&view=compound",
    "?position=uniswap-v4-rhc:1234",
    "?mint=abc&wallet=def",
  ])("keeps a shared link's query through the redirect (%s)", (query) => {
    const res = go(`/app${query}`);
    expect(res.status).toBe(307);
    expect(location(res)).toBe(`/app/portfolio${query}`);
  });
  it("still sends old ?openPool= links to the pools page, and leaves /app/portfolio alone", () => {
    expect(location(go("/app?openPool=poolone&position=raydium-clmm:x"))).toBe("/app/rwa-pairs?openPool=poolone");
    expect(go("/app/portfolio?position=raydium-clmm:x").headers.get("location")).toBeNull();
    expect(go("/app/portfolio/recovery").headers.get("location")).toBeNull();
  });
});
