import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs/config";
import { sentryBuildOptions } from "./src/lib/sentry/build";

export const nextConfig: NextConfig = {
  reactCompiler: true,
  // @sofinance/engine ships TypeScript source (vendored release of the prototype repo package).
  transpilePackages: ["@sofinance/engine"],
  async redirects() {
    return [
      { source: "/rwa-pairs", destination: "/app/rwa-pairs", permanent: true },
      { source: "/position-performance", destination: "/app/position-performance", permanent: true },
      { source: "/ai", destination: "/app/ai", permanent: true },
      { source: "/sign/:token", destination: "/app/sign/:token", permanent: true },
    ];
  },
};

export default withSentryConfig(nextConfig, sentryBuildOptions({
  authToken: process.env.SENTRY_AUTH_TOKEN,
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  ci: process.env.CI,
}));
