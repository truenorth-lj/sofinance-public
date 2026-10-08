import { describe, expect, it } from "vitest";
import nextConfig from "./next.config";

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
