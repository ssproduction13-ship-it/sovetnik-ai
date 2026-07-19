FROM node:24-slim AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@10.26.1 --activate

WORKDIR /app

# Copy workspace manifests for layer caching
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY lib/db/package.json                          ./lib/db/
COPY lib/api-zod/package.json                     ./lib/api-zod/
COPY lib/api-spec/package.json                    ./lib/api-spec/
COPY lib/integrations-openai-ai-server/package.json ./lib/integrations-openai-ai-server/
COPY artifacts/api-server/package.json            ./artifacts/api-server/

# Install all workspace dependencies
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

# Copy source
COPY tsconfig.json ./
COPY lib/db/                          ./lib/db/
COPY lib/api-zod/                     ./lib/api-zod/
COPY lib/api-spec/                    ./lib/api-spec/
COPY lib/integrations-openai-ai-server/ ./lib/integrations-openai-ai-server/
COPY artifacts/api-server/            ./artifacts/api-server/

# Build (esbuild bundles everything into dist/)
RUN pnpm --filter @workspace/api-server run build

# ---- runtime ----
FROM node:24-slim AS runner
WORKDIR /app

COPY --from=base /app/artifacts/api-server/dist ./dist

CMD ["node", "--enable-source-maps", "./dist/index.mjs"]
