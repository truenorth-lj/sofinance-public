# SoFinance web app (Next.js) for Railway. Selected per service with RAILWAY_DOCKERFILE_PATH=railway/web.Dockerfile;
# the repository-root Dockerfile is the separate RWA data service. Setup and env checklist: docs/deploy/railway.md.
#
# Railway passes service variables to the build only for names declared with ARG below, and its Dockerfile builder has
# no secret mounts. So the build gets public values only: NEXT_PUBLIC_* (inlined into the bundles; a change needs a
# rebuild) and the non-secret Sentry release names. No server secret (DB URLs, CRON_SECRET, RPC URLs, API keys,
# SENTRY_AUTH_TOKEN) is ever a build ARG: the build is the same keyless build CI runs, and data pages (ISR) fill in
# from the runtime env on their first revalidation. Server values reach only the runtime stage, from Railway at start.
# `src/lib/railway-deploy.test.ts` keeps this list in sync with the code and the env checklist.

FROM node:24-bookworm-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
RUN corepack enable && corepack prepare pnpm@10.18.2 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/engine/package.json ./packages/engine/package.json
RUN pnpm install --frozen-lockfile
COPY . .

# build-time:public — inlined into client and server bundles
ARG NEXT_PUBLIC_APP_URL
ARG NEXT_PUBLIC_POSTHOG_HOST
ARG NEXT_PUBLIC_POSTHOG_KEY
ARG NEXT_PUBLIC_REOWN_PROJECT_ID
ARG NEXT_PUBLIC_SENTRY_DSN
ARG NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE
ARG NEXT_PUBLIC_SOLANA_RPC_URL
# build-time:sentry — release names only (no auth token, so Railway builds upload no source maps)
ARG SENTRY_ORG
ARG SENTRY_PROJECT
ARG RAILWAY_GIT_COMMIT_SHA
RUN pnpm build

FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
# The whole built workspace: `next start` reads next.config.ts (and the src modules it imports), content/ and public/.
# ISR and the data cache write under .next/, so the app user owns the tree.
COPY --from=build --chown=node:node /app /app
USER node
EXPOSE 8080
# scripts/railway-web-start.ts runs `next start --hostname 0.0.0.0 --port $PORT` (Railway sets PORT; every interface so
# Railway's edge and private network reach it), then warms the store-backed ISR pages once it is healthy.
CMD ["node", "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "scripts/railway-web-start.ts"]
