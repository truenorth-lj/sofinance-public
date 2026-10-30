import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs/config";
import { sentryBuildOptions } from "./src/lib/sentry/build";
import { posthogRelayRewrites } from "./src/lib/analytics/relay";

export const nextConfig: NextConfig = {
  reactCompiler: true,
  // @sofinance/engine is a workspace package shipping TypeScript source.
  transpilePackages: ["@sofinance/engine"],
  // Client-visible deployment environment ("preview" enables SOL input on previews only; see feature-flags.ts).
  env: { NEXT_PUBLIC_SOFI_DEPLOY_ENV: process.env.VERCEL_ENV ?? "" },
  // PostHog's ingest paths end in "/" (e.g. /i/v0/e/). Without this, Next would 308 them before the
  // relay rewrite. Page trailing-slash redirects are kept in src/proxy.ts instead.
  skipTrailingSlashRedirect: true,
  async rewrites() {
    return posthogRelayRewrites(process.env.NEXT_PUBLIC_POSTHOG_HOST);
  },
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
