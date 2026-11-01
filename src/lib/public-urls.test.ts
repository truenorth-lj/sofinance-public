import { afterEach, describe, expect, it } from "vitest";
import { APP_ROUTES, CANONICAL_SITE_URL, SIGN_PATH, buildOpenPositionUrl, buildPlanPath, buildSignPath, buildSignUrl, getCanonicalSiteUrl, getPublicBaseUrl } from "./public-urls";

describe("public app URLs", () => {
  const originalAppUrl = process.env.NEXT_PUBLIC_APP_URL;
  const originalVercelUrl = process.env.VERCEL_URL;
  const originalVercelEnv = process.env.VERCEL_ENV;

  afterEach(() => {
    if (originalAppUrl === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
    else process.env.NEXT_PUBLIC_APP_URL = originalAppUrl;
    if (originalVercelUrl === undefined) delete process.env.VERCEL_URL;
    else process.env.VERCEL_URL = originalVercelUrl;
    if (originalVercelEnv === undefined) delete process.env.VERCEL_ENV;
    else process.env.VERCEL_ENV = originalVercelEnv;
  });

  it("keeps product pages under /app", () => {
    expect(APP_ROUTES.home).toBe("/app");
    expect(APP_ROUTES.plan).toBe("/app/plan");
    expect(APP_ROUTES.rwaPairs).toBe("/app/rwa-pairs");
    expect(APP_ROUTES.positionPerformance).toBe("/app/position-performance");
    expect(APP_ROUTES.ai).toBe("/app/ai");
    expect(SIGN_PATH).toBe("/app/sign");
    expect(buildSignPath("abc")).toBe("/app/sign/abc");
  });

  it("prefers NEXT_PUBLIC_APP_URL for absolute sign URLs", () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://sofinancelab.xyz/";
    process.env.VERCEL_URL = "ignored.vercel.app";
    expect(getPublicBaseUrl()).toBe("https://sofinancelab.xyz");
    expect(buildSignUrl("tok")).toBe("https://sofinancelab.xyz/app/sign/tok");
  });

  it("previews and vercel dev point at their own VERCEL_URL", () => {
    delete process.env.NEXT_PUBLIC_APP_URL;
    process.env.VERCEL_URL = "sofinance-abc123-team.vercel.app/";
    for (const env of ["preview", "development"]) {
      process.env.VERCEL_ENV = env;
      expect(getPublicBaseUrl()).toBe("https://sofinance-abc123-team.vercel.app");
      expect(buildSignUrl("tok")).toBe("https://sofinance-abc123-team.vercel.app/app/sign/tok");
    }
  });

  it("production never hands out the per-deployment vercel.app host", () => {
    delete process.env.NEXT_PUBLIC_APP_URL;
    process.env.VERCEL_URL = "sofinance-abc123-team.vercel.app";
    for (const env of ["production", undefined, "", "unexpected"]) {
      if (env === undefined) delete process.env.VERCEL_ENV;
      else process.env.VERCEL_ENV = env;
      expect(getPublicBaseUrl()).toBe(CANONICAL_SITE_URL);
      expect(buildSignUrl("tok")).toBe("https://sofinancelab.xyz/app/sign/tok");
      expect(buildOpenPositionUrl("Pool1")).toBe("https://sofinancelab.xyz/app/rwa-pairs?pool=Pool1&open=1");
    }
  });

  it("uses root-relative paths off Vercel", () => {
    delete process.env.NEXT_PUBLIC_APP_URL;
    delete process.env.VERCEL_URL;
    process.env.VERCEL_ENV = "production";
    expect(getPublicBaseUrl()).toBe("");
    expect(buildSignUrl("tok")).toBe("/app/sign/tok");
  });

  it("builds an open-position deep link under /app/rwa-pairs", () => {
    delete process.env.NEXT_PUBLIC_APP_URL;
    delete process.env.VERCEL_URL;
    expect(buildOpenPositionUrl("Pool1111111111111111111111111111111111111")).toBe(
      "/app/rwa-pairs?pool=Pool1111111111111111111111111111111111111&open=1",
    );
  });

  it("uses NEXT_PUBLIC_APP_URL or the production origin for SEO URLs", () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://sofinancelab.xyz/";
    process.env.VERCEL_URL = "ignored.vercel.app";
    expect(getCanonicalSiteUrl()).toBe("https://sofinancelab.xyz");

    delete process.env.NEXT_PUBLIC_APP_URL;
    expect(getCanonicalSiteUrl()).toBe(CANONICAL_SITE_URL);
    expect(CANONICAL_SITE_URL).toBe("https://sofinancelab.xyz");
  });

  it("builds a plan deep link with the pool id and optional pair label", () => {
    expect(buildPlanPath({ poolId: "Pool1111111111111111111111111111111111111" })).toBe(
      "/app/plan?pool=Pool1111111111111111111111111111111111111",
    );
    expect(
      buildPlanPath({ poolId: "Pool1111111111111111111111111111111111111", pair: "SPCXx/SPCX" }),
    ).toBe("/app/plan?pool=Pool1111111111111111111111111111111111111&pair=SPCXx%2FSPCX");
  });
});
