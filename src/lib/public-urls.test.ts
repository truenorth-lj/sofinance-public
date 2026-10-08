import { afterEach, describe, expect, it } from "vitest";
import { APP_ROUTES, SIGN_PATH, buildSignPath, buildSignUrl, getPublicBaseUrl } from "./public-urls";

describe("public app URLs", () => {
  const originalAppUrl = process.env.NEXT_PUBLIC_APP_URL;
  const originalVercelUrl = process.env.VERCEL_URL;

  afterEach(() => {
    if (originalAppUrl === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
    else process.env.NEXT_PUBLIC_APP_URL = originalAppUrl;
    if (originalVercelUrl === undefined) delete process.env.VERCEL_URL;
    else process.env.VERCEL_URL = originalVercelUrl;
  });

  it("keeps product pages under /app", () => {
    expect(APP_ROUTES.home).toBe("/app");
    expect(APP_ROUTES.rwaPairs).toBe("/app/rwa-pairs");
    expect(APP_ROUTES.positionPerformance).toBe("/app/position-performance");
    expect(APP_ROUTES.ai).toBe("/app/ai");
    expect(SIGN_PATH).toBe("/app/sign");
    expect(buildSignPath("abc")).toBe("/app/sign/abc");
  });

  it("prefers NEXT_PUBLIC_APP_URL for absolute sign URLs", () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://sofinance-alpha.vercel.app/";
    process.env.VERCEL_URL = "ignored.vercel.app";
    expect(getPublicBaseUrl()).toBe("https://sofinance-alpha.vercel.app");
    expect(buildSignUrl("tok")).toBe("https://sofinance-alpha.vercel.app/app/sign/tok");
  });

  it("falls back to VERCEL_URL and root-relative paths", () => {
    delete process.env.NEXT_PUBLIC_APP_URL;
    process.env.VERCEL_URL = "sofinance-alpha.vercel.app";
    expect(buildSignUrl("tok")).toBe("https://sofinance-alpha.vercel.app/app/sign/tok");

    delete process.env.VERCEL_URL;
    expect(buildSignUrl("tok")).toBe("/app/sign/tok");
  });
});
