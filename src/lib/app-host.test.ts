import { describe, expect, it } from "vitest";
import { appSubdomainRewritePath, isAppSubdomainHost, trailingSlashRedirectPath } from "./app-host";
import { config } from "../proxy";

describe("app subdomain host", () => {
  it("rewrites only custom app. hosts, never *.vercel.app", () => {
    expect(isAppSubdomainHost("app.sofinance.xyz")).toBe(true);
    expect(isAppSubdomainHost("app.sofinance.xyz:443")).toBe(true);
    expect(isAppSubdomainHost("sofinance.xyz")).toBe(false);
    expect(isAppSubdomainHost("example.vercel.app")).toBe(false);
    expect(isAppSubdomainHost("app.example.vercel.app")).toBe(false);
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
    expect(appSubdomainRewritePath("/favicon.ico")).toBe(null);
    expect(appSubdomainRewritePath("/sitemap.xml")).toBe(null);
    expect(appSubdomainRewritePath("/robots.txt")).toBe(null);
    expect(appSubdomainRewritePath("/_next/static/chunk.js")).toBe(null);
    expect(appSubdomainRewritePath("/lumen/i/v0/e/")).toBe(null);
  });
});

describe("trailing slash and the PostHog relay", () => {
  it("redirects page paths to the slashless form but leaves the relay alone", () => {
    expect(trailingSlashRedirectPath("/")).toBe(null);
    expect(trailingSlashRedirectPath("/app")).toBe(null);
    expect(trailingSlashRedirectPath("/app/")).toBe("/app");
    expect(trailingSlashRedirectPath("/app/rwa-pairs//")).toBe("/app/rwa-pairs");
    expect(trailingSlashRedirectPath("/lumen/i/v0/e/")).toBe(null);
  });

  it("keeps the relay out of the Proxy matcher", () => {
    const matcher = new RegExp(`^${(config.matcher[0] ?? "").replace("/((?!", "/(?!(?:").replace(").*)", ")).*")}$`);
    expect(matcher.test("/app/rwa-pairs")).toBe(true);
    expect(matcher.test("/lumen/i/v0/e/")).toBe(false);
    expect(matcher.test("/lumen/static/array.js")).toBe(false);
  });
});
