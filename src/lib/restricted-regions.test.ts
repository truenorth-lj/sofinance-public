import { describe, expect, it } from "vitest";
import {
  evaluateRegion,
  geoOverrideAllowed,
  normalizeSubdivision,
  parseGeoOverride,
  readGeo,
  RESTRICTED_COUNTRIES,
} from "./restricted-regions";

const headers = (values: Record<string, string>) => new Headers(values);

describe("evaluateRegion", () => {
  it.each(["TW", "US", "PR", "GU", "VI", "AS", "MP", "UM", "CU", "IR", "KP", "SY"])("blocks %s", (country) => {
    expect(evaluateRegion({ country, region: null }).blocked).toBe(true);
  });

  it("blocks exactly the documented country list", () => {
    expect(Object.keys(RESTRICTED_COUNTRIES).sort()).toEqual(["AS", "CU", "GU", "IR", "KP", "MP", "PR", "SY", "TW", "UM", "US", "VI"]);
  });

  it("is case and whitespace insensitive", () => {
    expect(evaluateRegion({ country: " tw ", region: null }).blocked).toBe(true);
  });

  it.each([["43", "Crimea"], ["40", "Sevastopol"], ["14", "Donetsk"], ["09", "Luhansk"], ["9", "Luhansk"], ["UA-43", "Crimea"]])(
    "blocks Ukraine region %s (%s)", (region, label) => {
      const decision = evaluateRegion({ country: "UA", region });
      expect(decision).toMatchObject({ blocked: true, country: "UA", label });
    });

  it("allows the rest of Ukraine, including when the region header is missing", () => {
    expect(evaluateRegion({ country: "UA", region: "30" }).blocked).toBe(false);
    expect(evaluateRegion({ country: "UA", region: null }).blocked).toBe(false);
  });

  it("only applies subdivision codes inside their own country", () => {
    expect(evaluateRegion({ country: "JP", region: "43" }).blocked).toBe(false);
    expect(evaluateRegion({ country: "RU", region: "14" }).blocked).toBe(false);
  });

  it("allows other countries and unknown location (no header, e.g. local dev)", () => {
    for (const country of ["JP", "SG", "GB", "DE", "HK", "KR"]) expect(evaluateRegion({ country, region: null }).blocked).toBe(false);
    expect(evaluateRegion({ country: null, region: null }).blocked).toBe(false);
  });

  it("normalizes subdivision codes", () => {
    expect(normalizeSubdivision("UA", "ua-09")).toBe("09");
    expect(normalizeSubdivision("UA", "")).toBe(null);
  });
});

describe("geo override (test-only)", () => {
  it("is never honoured on Vercel production", () => {
    expect(geoOverrideAllowed({ VERCEL: "1", VERCEL_ENV: "production", NODE_ENV: "production" })).toBe(false);
    const geo = readGeo(headers({ "x-vercel-ip-country": "TW", "x-sofinance-geo-override": "JP" }), {
      query: new URLSearchParams("__geo=JP"), env: { VERCEL: "1", VERCEL_ENV: "production", NODE_ENV: "production" },
    });
    expect(geo).toEqual({ country: "TW", region: null, overridden: false });
  });

  it("is honoured on preview deployments and next dev only", () => {
    expect(geoOverrideAllowed({ VERCEL: "1", VERCEL_ENV: "preview", NODE_ENV: "production" })).toBe(true);
    expect(geoOverrideAllowed({ NODE_ENV: "development" })).toBe(true);
    expect(geoOverrideAllowed({ NODE_ENV: "production" })).toBe(false);
    expect(geoOverrideAllowed({ VERCEL: "1", NODE_ENV: "production" })).toBe(false);
  });

  it("prefers query, then header, then cookie", () => {
    const env = { VERCEL: "1", VERCEL_ENV: "preview" };
    const cookies = { get: (name: string) => name === "sofinance_geo_override" ? { value: "US" } : undefined };
    expect(readGeo(headers({ "x-vercel-ip-country": "TW" }), { env, cookies })).toMatchObject({ country: "US", overridden: true });
    expect(readGeo(headers({ "x-sofinance-geo-override": "UA-43" }), { env, cookies })).toMatchObject({ country: "UA", region: "43" });
    expect(readGeo(headers({}), { env, cookies, query: new URLSearchParams("__geo=jp") })).toMatchObject({ country: "JP" });
  });

  it("parses overrides strictly", () => {
    expect(parseGeoOverride("UA:43")).toEqual({ country: "UA", region: "43" });
    expect(parseGeoOverride("USA")).toBe(null);
    expect(parseGeoOverride("")).toBe(null);
  });

  it("reads the Vercel headers when no override applies", () => {
    expect(readGeo(headers({ "x-vercel-ip-country": "UA", "x-vercel-ip-country-region": "14" }), { env: { VERCEL: "1", VERCEL_ENV: "production" } }))
      .toEqual({ country: "UA", region: "14", overridden: false });
  });
});
