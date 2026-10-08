import { describe, expect, it } from "vitest";
import { appSubdomainRewritePath, isAppSubdomainHost } from "./app-host";

describe("app subdomain host", () => {
  it("rewrites only custom app. hosts, never *.vercel.app", () => {
    expect(isAppSubdomainHost("app.sofinance.xyz")).toBe(true);
    expect(isAppSubdomainHost("app.sofinance.xyz:443")).toBe(true);
    expect(isAppSubdomainHost("sofinance.xyz")).toBe(false);
    expect(isAppSubdomainHost("sofinance-alpha.vercel.app")).toBe(false);
    expect(isAppSubdomainHost("app.sofinance-alpha.vercel.app")).toBe(false);
    expect(isAppSubdomainHost("localhost:3000")).toBe(false);
    expect(isAppSubdomainHost(null)).toBe(false);
  });

  it("maps subdomain paths onto /app without touching APIs or assets", () => {
    expect(appSubdomainRewritePath("/")).toBe("/app");
    expect(appSubdomainRewritePath("/rwa-pairs")).toBe("/app/rwa-pairs");
    expect(appSubdomainRewritePath("/sign/abc")).toBe("/app/sign/abc");
    expect(appSubdomainRewritePath("/app")).toBe(null);
    expect(appSubdomainRewritePath("/app/ai")).toBe(null);
    expect(appSubdomainRewritePath("/api/mcp")).toBe(null);
    expect(appSubdomainRewritePath("/logo.png")).toBe(null);
    expect(appSubdomainRewritePath("/_next/static/chunk.js")).toBe(null);
  });
});
