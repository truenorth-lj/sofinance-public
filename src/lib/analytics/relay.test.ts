import { describe, expect, it } from "vitest";
import { isPosthogRelayPath, POSTHOG_RELAY_PATH, posthogRelayRewrites, posthogUpstream } from "./relay";

describe("PostHog first-party relay", () => {
  it("routes assets and remote config to the assets host and everything else to ingest", () => {
    expect(posthogRelayRewrites()).toEqual([
      { source: "/lumen/static/:path*", destination: "https://us-assets.i.posthog.com/static/:path*" },
      { source: "/lumen/array/:path*", destination: "https://us-assets.i.posthog.com/array/:path*" },
      { source: "/lumen/:path*", destination: "https://us.i.posthog.com/:path*" },
    ]);
  });

  it("follows NEXT_PUBLIC_POSTHOG_HOST region and tolerates a trailing slash", () => {
    expect(posthogUpstream("https://eu.i.posthog.com/")).toEqual({
      ingest: "https://eu.i.posthog.com",
      assets: "https://eu-assets.i.posthog.com",
      ui: "https://eu.posthog.com",
    });
    expect(posthogUpstream(" ")).toEqual({
      ingest: "https://us.i.posthog.com",
      assets: "https://us-assets.i.posthog.com",
      ui: "https://us.posthog.com",
    });
  });

  it("uses a path that is not an obvious analytics name", () => {
    expect(POSTHOG_RELAY_PATH).not.toMatch(/posthog|ingest|analytics|track/i);
    expect(isPosthogRelayPath("/lumen/i/v0/e/")).toBe(true);
    expect(isPosthogRelayPath("/lumen")).toBe(true);
    expect(isPosthogRelayPath("/lumens")).toBe(false);
  });
});
