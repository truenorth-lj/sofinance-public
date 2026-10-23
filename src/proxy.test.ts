import { deflateSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { getRewrittenUrl, isRewrite } from "next/experimental/testing/server";
import { proxy } from "./proxy";

const request = (path: string, headers: Record<string, string> = {}, method = "GET") =>
  new NextRequest(`https://sofinancelab.xyz${path}`, { method, headers });
const from = (country: string, region?: string) => ({
  "x-vercel-ip-country": country,
  ...(region ? { "x-vercel-ip-country-region": region } : {}),
});
const signToken = (kind: string) => `sig.${deflateSync(Buffer.from(JSON.stringify({ kind, wallet: "w" }))).toString("base64url")}`;

beforeEach(() => { vi.stubEnv("VERCEL", "1"); vi.stubEnv("VERCEL_ENV", "production"); });
afterEach(() => { vi.unstubAllEnvs(); });

describe("proxy restricted-region gate", () => {
  it("returns 403 JSON for order-building APIs from restricted regions", async () => {
    for (const [country, region] of [["TW"], ["US"], ["PR"], ["IR"], ["UA", "43"], ["UA", "09"]] as const) {
      const response = proxy(request("/api/open-prepare", from(country, region), "POST"));
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code: "region_restricted", country });
    }
  });

  it("lets withdrawals and recovery through from restricted regions", () => {
    for (const path of ["/api/withdraw-quote", "/api/withdraw-prepare", "/api/withdraw-broadcast", "/api/withdraw-status",
      "/api/compound-recover-prepare", "/api/compound-cleanup-broadcast", "/api/wallet"]) {
      const response = proxy(request(path, from("TW"), "POST"));
      expect(response.status).toBe(200);
      expect(isRewrite(response)).toBe(false);
    }
  });

  it("renders the blocked page for /app but keeps landing, docs, terms and /app/exit reachable", () => {
    const blocked = proxy(request("/app/rwa-pairs?pool=x", from("US")));
    expect(isRewrite(blocked)).toBe(true);
    expect(new URL(getRewrittenUrl(blocked)!).pathname).toBe("/restricted");
    for (const path of ["/", "/docs", "/docs/withdraw", "/terms", "/app/exit", "/restricted"]) {
      expect(isRewrite(proxy(request(path, from("US"))))).toBe(false);
    }
  });

  it("allows withdrawal sign links only", () => {
    expect(isRewrite(proxy(request(`/app/sign/${signToken("withdraw")}`, from("TW"))))).toBe(false);
    for (const kind of ["open-position", "add-liquidity", "compound"]) {
      expect(new URL(getRewrittenUrl(proxy(request(`/app/sign/${signToken(kind)}`, from("TW"))))!).pathname).toBe("/restricted");
    }
    expect(new URL(getRewrittenUrl(proxy(request("/app/sign/garbage", from("TW"))))!).pathname).toBe("/restricted");
  });

  it("does nothing for allowed countries", () => {
    expect(proxy(request("/api/open-prepare", from("JP"), "POST")).status).toBe(200);
    expect(isRewrite(proxy(request("/app", from("UA", "30"))))).toBe(false);
  });

  it("applies the gate after the app. subdomain rewrite", () => {
    const response = proxy(new NextRequest("https://app.sofinancelab.xyz/rwa-pairs", { headers: { host: "app.sofinancelab.xyz", ...from("TW") } }));
    expect(new URL(getRewrittenUrl(response)!).pathname).toBe("/restricted");
    const allowed = proxy(new NextRequest("https://app.sofinancelab.xyz/rwa-pairs", { headers: { host: "app.sofinancelab.xyz", ...from("JP") } }));
    expect(new URL(getRewrittenUrl(allowed)!).pathname).toBe("/app/rwa-pairs");
  });

  it("ignores the geo override in production", () => {
    expect(proxy(request("/api/open-prepare?__geo=JP", { ...from("TW"), "x-sofinance-geo-override": "JP" }, "POST")).status).toBe(403);
    expect(proxy(request("/api/open-prepare?__geo=TW", from("JP"), "POST")).status).toBe(200);
  });

  it("honours the geo override on preview deployments and sets a sticky cookie", () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    expect(proxy(request("/api/open-prepare?__geo=JP", from("TW"), "POST")).status).toBe(200);
    const simulated = proxy(request("/app?__geo=US", from("JP")));
    expect(new URL(getRewrittenUrl(simulated)!).pathname).toBe("/restricted");
    expect(simulated.cookies.get("sofinance_geo_override")?.value).toBe("US");
  });
});
