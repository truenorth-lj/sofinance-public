# SoFinance web app (Next.js) for Railway. Selected per service with RAILWAY_DOCKERFILE_PATH=railway/web.Dockerfile;
# the repository-root Dockerfile is the separate RWA data service. Setup and env checklist: docs/deploy/railway.md.
#
# Railway passes service variables to the build only for names declared with ARG below. Vercel exposes every env var
# to `next build`, so this list mirrors that: NEXT_PUBLIC_* are inlined into the bundles at build time (a change needs
# a rebuild), SENTRY_* upload source maps, and the server vars let prerendered/ISR pages read data during the build
# exactly as on Vercel. ARGs live only in the build stage; the runtime stage gets its env from Railway at start.
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
# build-time:sentry — source-map upload and release name
ARG SENTRY_AUTH_TOKEN
ARG SENTRY_ORG
ARG SENTRY_PROJECT
ARG RAILWAY_GIT_COMMIT_SHA
# build-time:server — same values as runtime, for prerender parity with Vercel builds
ARG ALCHEMY_RPC_URL
ARG CRON_SECRET
ARG DATABASE_URL
ARG JUPITER_API_KEY
ARG RHC_UNIV4_FEE_WALLET
ARG SENTRY_DSN
ARG SOFINANCE_FEE_WALLET
ARG SOFINANCE_POSITION_HISTORY_DB_ENABLED
ARG SOFINANCE_RWA_DATABASE_URL
ARG SOFINANCE_RWA_DB_CA_PEM
ARG SOFINANCE_RWA_DB_ENABLED
ARG SOFINANCE_RWA_DB_EXPECTED_ROLE
ARG SOFINANCE_RWA_GATEWAY_URL
ARG SOFINANCE_RWA_NATIVE_CRON_ENABLED
ARG SOFINANCE_RWA_REFRESH_ENABLED
ARG SOFINANCE_RWA_STORE_MODE
ARG SOLANA_RPC_PROVIDERS
ARG SOLANA_RPC_URL
RUN pnpm build

FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
# The whole built workspace: `next start` reads next.config.ts (and the src modules it imports), content/ and public/.
# ISR and the data cache write under .next/, so the app user owns the tree.
COPY --from=build --chown=node:node /app /app
USER node
EXPOSE 8080
# Railway sets PORT; bind every interface so Railway's edge and private network can reach the server.
CMD ["sh", "-c", "exec node_modules/.bin/next start --hostname 0.0.0.0 --port \"${PORT:-8080}\""]
