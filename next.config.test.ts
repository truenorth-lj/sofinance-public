import { describe, expect, it } from "vitest";
import { nextConfig } from "./next.config";
import { sentryBuildOptions, sentrySourceMapsEnabled } from "./src/lib/sentry/build";

describe("legacy page redirects", () => {
  it("permanently maps former UI paths onto /app", async () => {
    const redirects = nextConfig.redirects ? await nextConfig.redirects() : [];
    expect(redirects).toEqual(
      expect.arrayContaining([
        { source: "/rwa-pairs", destination: "/app/rwa-pairs", permanent: true },
        { source: "/position-performance", destination: "/app/position-performance", permanent: true },
        { source: "/ai", destination: "/app/ai", permanent: true },
        { source: "/sign/:token", destination: "/app/sign/:token", permanent: true },
      ]),
    );
  });
});

describe("Sentry source-map upload gating", () => {
  it("disables upload unless auth token, org, and project are all set", () => {
    expect(sentrySourceMapsEnabled({})).toBe(false);
    expect(sentrySourceMapsEnabled({ authToken: "t", org: "o" })).toBe(false);
    expect(sentrySourceMapsEnabled({ authToken: "t", org: "o", project: "p" })).toBe(true);
    expect(sentryBuildOptions({}).sourcemaps.disable).toBe(true);
    expect(sentryBuildOptions({ authToken: "t", org: "o", project: "p" }).sourcemaps.disable).toBe(false);
    expect(sentryBuildOptions({}).release.create).toBe(false);
  });
});
