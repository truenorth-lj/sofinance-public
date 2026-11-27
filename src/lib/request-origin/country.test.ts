import { describe, expect, it } from "vitest";
import { GEO_PROVIDERS, requestCountry } from "./country";

const headers = (init: Record<string, string>) => new Headers(init);
const VERCEL_OR_LOCAL = {};
const RAILWAY = { RAILWAY_PROJECT_ID: "railway-project" };
const CLOUDFLARE = { SOFINANCE_TRUST_CLOUDFLARE_HEADERS: "true" };

describe("requestCountry", () => {
  it("checks Cloudflare first, then Vercel", () => {
    expect(GEO_PROVIDERS.map((p) => [p.id, p.header])).toEqual([
      ["cloudflare", "cf-ipcountry"],
      ["vercel", "x-vercel-ip-country"],
    ]);
  });

  it("reads x-vercel-ip-country off Railway exactly as before (trim + upper-case, empty = unknown)", () => {
    expect(requestCountry(headers({ "x-vercel-ip-country": "US" }), VERCEL_OR_LOCAL)).toEqual({ country: "US", provider: "vercel" });
    expect(requestCountry(headers({ "x-vercel-ip-country": " tw " }), VERCEL_OR_LOCAL)).toEqual({ country: "TW", provider: "vercel" });
    expect(requestCountry(headers({ "x-vercel-ip-country": "  " }), VERCEL_OR_LOCAL)).toBeNull();
    expect(requestCountry(headers({}), VERCEL_OR_LOCAL)).toBeNull();
  });

  it("ignores CF-IPCountry unless Cloudflare headers are trusted, so it can never override Vercel by default", () => {
    const both = headers({ "cf-ipcountry": "US", "x-vercel-ip-country": "TW" });
    expect(requestCountry(both, VERCEL_OR_LOCAL)).toEqual({ country: "TW", provider: "vercel" });
    expect(requestCountry(headers({ "cf-ipcountry": "US" }), VERCEL_OR_LOCAL)).toBeNull();
    expect(requestCountry(both, CLOUDFLARE)).toEqual({ country: "US", provider: "cloudflare" });
  });

  it("treats Cloudflare's XX (no data) as missing and falls through to the next provider", () => {
    expect(requestCountry(headers({ "cf-ipcountry": "XX", "x-vercel-ip-country": "GB" }), CLOUDFLARE))
      .toEqual({ country: "GB", provider: "vercel" });
    expect(requestCountry(headers({ "cf-ipcountry": "xx" }), CLOUDFLARE)).toBeNull();
  });

  it("ignores a client-sent x-vercel-ip-country on Railway", () => {
    expect(requestCountry(headers({ "x-vercel-ip-country": "US" }), RAILWAY)).toBeNull();
    expect(requestCountry(headers({ "cf-ipcountry": "AU", "x-vercel-ip-country": "US" }), { ...RAILWAY, ...CLOUDFLARE }))
      .toEqual({ country: "AU", provider: "cloudflare" });
  });

  it("only an exact \"true\" turns Cloudflare trust on", () => {
    for (const value of ["1", "TRUE", "yes", ""]) {
      expect(requestCountry(headers({ "cf-ipcountry": "US" }), { SOFINANCE_TRUST_CLOUDFLARE_HEADERS: value })).toBeNull();
    }
  });
});
