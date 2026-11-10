import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "../proxy";
import {
  hasRegionNoticeCookie,
  isRegionNoticePath,
  REGION_NOTICE_COOKIE,
  REGION_NOTICE_COUNTRIES,
  REGION_NOTICE_FORCE_COUNTRY_PARAM,
  REGION_NOTICE_FORCE_PARAM,
  REGION_NOTICE_LINK_TEXT,
  REGION_NOTICE_PATHS,
  REGION_NOTICE_TEXT,
  regionNoticeForCountry,
  resolveNoticeCountry,
  XSTOCKS_ELIGIBILITY_TERMS_URL,
} from "./region-notice";

const NOTICE = ["US", "CA", "GB", "AU"] as const;

function visit(path: string, country?: string, cookie?: string) {
  const headers = new Headers({ host: "sofinancelab.xyz" });
  if (country) headers.set("x-vercel-ip-country", country);
  if (cookie) headers.set("cookie", cookie);
  return proxy(new NextRequest(`https://sofinancelab.xyz${path}`, { headers }));
}

afterEach(() => vi.unstubAllEnvs());

describe("region notice list", () => {
  it("is exactly US, CA, GB and AU", () => {
    expect([...REGION_NOTICE_COUNTRIES].sort()).toEqual([...NOTICE].sort());
  });

  it("maps Vercel country codes to show / hide / unknown", () => {
    for (const code of NOTICE) expect(regionNoticeForCountry(code)).toBe(true);
    expect(regionNoticeForCountry(" us ")).toBe(true);
    expect(regionNoticeForCountry("TW")).toBe(false);
    expect(regionNoticeForCountry("DE")).toBe(false);
    expect(regionNoticeForCountry("")).toBe(null);
    expect(regionNoticeForCountry(null)).toBe(null);
    expect(regionNoticeForCountry(undefined)).toBe(null);
  });

  it("reads only the exact flag cookie", () => {
    expect(hasRegionNoticeCookie(`a=b; ${REGION_NOTICE_COOKIE}=1`)).toBe(true);
    expect(hasRegionNoticeCookie(`${REGION_NOTICE_COOKIE}=0`)).toBe(false);
    expect(hasRegionNoticeCookie(`x${REGION_NOTICE_COOKIE}=1`)).toBe(false);
    expect(hasRegionNoticeCookie("")).toBe(false);
  });

  it("is not duplicated in the Proxy", () => {
    const proxySource = readFileSync(resolve("src/proxy.ts"), "utf8");
    expect(proxySource).not.toMatch(/["'](?:US|CA|GB|AU)["']/);
  });
});

describe("region notice paths", () => {
  it("is only /app and /app/rwa-pairs", () => {
    expect([...REGION_NOTICE_PATHS]).toEqual(["/app", "/app/rwa-pairs"]);
    expect(isRegionNoticePath("/app")).toBe(true);
    expect(isRegionNoticePath("/app/rwa-pairs")).toBe(true);
    expect(isRegionNoticePath("/app/")).toBe(true);
    expect(isRegionNoticePath("/app/rwa-pairs/")).toBe(true);
    expect(isRegionNoticePath("/")).toBe(false);
    expect(isRegionNoticePath("/app/ai")).toBe(false);
    expect(isRegionNoticePath("/docs")).toBe(false);
    expect(isRegionNoticePath("")).toBe(false);
    expect(isRegionNoticePath(null)).toBe(false);
  });
});

describe("region notice copy", () => {
  it("names xStocks availability and links to the official eligibility terms", () => {
    expect(REGION_NOTICE_TEXT).toBe(
      "xStocks tokens may not be available in your region. Check xStocks' eligibility terms before trading.",
    );
    expect(REGION_NOTICE_TEXT).toContain(REGION_NOTICE_LINK_TEXT);
    expect(XSTOCKS_ELIGIBILITY_TERMS_URL).toBe("https://docs.xstocks.fi/docs/product-legal-overview");
    expect(REGION_NOTICE_TEXT).not.toMatch(/backtest|earn|yield|auto-rebalance|guaranteed/i);
  });
});

describe("non-production country override", () => {
  const params = (query: string) => new URLSearchParams(query);

  it("uses the Vercel header when no override is present", () => {
    expect(resolveNoticeCountry("TW", params(""), "preview")).toBe("TW");
    expect(resolveNoticeCountry(null, params(""), undefined)).toBe(null);
  });

  it("honors forceCountry and forceRegionNotice outside production", () => {
    expect(resolveNoticeCountry(null, params(`${REGION_NOTICE_FORCE_COUNTRY_PARAM}=CA`), undefined)).toBe("CA");
    expect(resolveNoticeCountry("TW", params(`${REGION_NOTICE_FORCE_PARAM}=1`), "preview")).toBe("US");
  });

  it("ignores the override in production", () => {
    expect(resolveNoticeCountry(null, params(`${REGION_NOTICE_FORCE_PARAM}=1`), "production")).toBe(null);
    expect(resolveNoticeCountry("TW", params(`${REGION_NOTICE_FORCE_COUNTRY_PARAM}=US`), "production")).toBe("TW");
  });
});

describe("Proxy never blocks notice countries", () => {
  for (const code of NOTICE) {
    it(`${code}: page and app load normally and get the notice flag`, () => {
      for (const path of ["/", "/app", "/app/rwa-pairs", "/app/sign/abc", "/terms"]) {
        const response = visit(path, code);
        expect(response.status).toBe(200);
        expect(response.headers.get("location")).toBe(null);
        expect(response.headers.get("x-middleware-rewrite")).toBe(null);
        expect(response.cookies.get(REGION_NOTICE_COOKIE)?.value).toBe("1");
      }
    });
  }

  it("does not set the flag elsewhere or without a geo header, and clears a stale one", () => {
    expect(visit("/app", "TW").cookies.get(REGION_NOTICE_COOKIE)).toBeUndefined();
    expect(visit("/app").cookies.get(REGION_NOTICE_COOKIE)).toBeUndefined();
    const stale = visit("/app", "TW", `${REGION_NOTICE_COOKIE}=1`).cookies.get(REGION_NOTICE_COOKIE);
    expect(stale?.value).toBe("");
    expect(visit("/app", undefined, `${REGION_NOTICE_COOKIE}=1`).cookies.get(REGION_NOTICE_COOKIE)).toBeUndefined();
  });

  it("does not re-send the cookie when it is already set", () => {
    expect(visit("/app", "US", `${REGION_NOTICE_COOKIE}=1`).cookies.get(REGION_NOTICE_COOKIE)).toBeUndefined();
  });

  it("keeps the trailing-slash redirect unchanged", () => {
    const response = visit("/app/", "US");
    expect(response.status).toBe(308);
    expect(new URL(response.headers.get("location")!).pathname).toBe("/app");
  });

  it("sets the flag from forceRegionNotice outside production", () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    expect(visit(`/app?${REGION_NOTICE_FORCE_PARAM}=1`).cookies.get(REGION_NOTICE_COOKIE)?.value).toBe("1");
  });

  it("ignores forceRegionNotice in production", () => {
    vi.stubEnv("VERCEL_ENV", "production");
    expect(visit(`/app?${REGION_NOTICE_FORCE_PARAM}=1`).cookies.get(REGION_NOTICE_COOKIE)).toBeUndefined();
  });
});
