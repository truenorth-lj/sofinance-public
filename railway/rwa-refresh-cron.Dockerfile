# Railway cron service for the RWA refresh: runs once per schedule (RWA_REFRESH_CRON, "15 */4 * * *" UTC), calls
# /api/internal/rwa-refresh with the CRON_SECRET bearer, and exits. Selected with
# RAILWAY_DOCKERFILE_PATH=railway/rwa-refresh-cron.Dockerfile. No dependencies: Node runs the TypeScript directly.
# Setup and the "never both platforms" switch: docs/deploy/railway.md.
FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
RUN echo '{"type":"module","private":true}' > package.json
COPY src/lib/rwa-refresh-trigger.ts ./src/lib/rwa-refresh-trigger.ts
COPY scripts/rwa-refresh-cron.ts ./scripts/rwa-refresh-cron.ts
USER node
CMD ["node", "scripts/rwa-refresh-cron.ts"]
