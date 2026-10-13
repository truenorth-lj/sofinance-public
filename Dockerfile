FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.18.2 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY src ./src
COPY scripts ./scripts
COPY tsconfig.json ./
RUN pnpm run build:rwa-service

FROM node:24-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/dist/rwa-data-service.cjs ./server.cjs
USER node
EXPOSE 3000
CMD ["node", "server.cjs"]
