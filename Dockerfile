FROM node:24-slim AS builder
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@10.26.1 --activate

WORKDIR /app

# Copy everything needed for the build
COPY . .

# Install dependencies and build
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @workspace/api-server run build

# ---- runtime ----
FROM node:24-slim
WORKDIR /app

# Keep the same path as build so pino worker paths resolve correctly
COPY --from=builder /app/artifacts/api-server/dist ./artifacts/api-server/dist

CMD ["node", "--enable-source-maps", "./artifacts/api-server/dist/index.mjs"]
