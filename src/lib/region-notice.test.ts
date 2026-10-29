import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { proxy } from "../proxy";
import {
  hasRegionNoticeCookie, REGION_NOTICE_COOKIE, REGION_NOTICE_COUNTRIES, REGION_NOTICE_TEXT, regionNoticeForCountry,
} from "./region-notice";

const NOTICE = ["US", "CA", "GB", "AU"] as const;

function visit(path: string, country?: string, cookie?: string) {
  const headers = new Headers({ host: "sofinancelab.xyz" });
  if (country) headers.set("x-vercel-ip-country", country);
  if (cookie) headers.set("cookie", cookie);
  return proxy(new NextRequest(`https://sofinancelab.xyz${path}`, { headers }));
}

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

describe("region notice copy", () => {
  it("is informational, with no legal promise or regulatory claim", () => {
    expect(REGION_NOTICE_TEXT).toContain("self-custody");
    expect(REGION_NOTICE_TEXT).not.toMatch(/guarantee|compliant|compliance|licen[cs]ed|registered|regulated|approved|legal advice|prohibited|not available|blocked|banned|illegal/i);
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
});
