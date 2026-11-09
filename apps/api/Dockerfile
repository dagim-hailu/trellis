# Trellis API service.
#
# Build context is the repository root so the workspace packages resolve.
# The image builds the workspace packages, then runs the compiled API.

FROM node:24.14.0-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@11.28.5 --activate
WORKDIR /app

# ---------------------------------------------------------------------------
# Dependency layer. Copied separately so a source-only change does not
# re-resolve the lockfile.
# ---------------------------------------------------------------------------
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/auth/package.json ./packages/auth/
COPY packages/db/package.json ./packages/db/
COPY apps/api/package.json ./apps/api/
COPY apps/realtime/package.json ./apps/realtime/
COPY apps/web/package.json ./apps/web/
RUN pnpm install --frozen-lockfile --filter @trellis/api... --filter @trellis/db... --filter @trellis/shared... --filter @trellis/auth...

# ---------------------------------------------------------------------------
# Build layer.
# ---------------------------------------------------------------------------
FROM deps AS build
COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps/api ./apps/api
RUN pnpm --filter "./packages/*" run build \
 && pnpm --filter @trellis/api run build

# ---------------------------------------------------------------------------
# Runtime layer. Only the compiled output, the workspace packages it imports,
# and the production dependency tree.
# ---------------------------------------------------------------------------
FROM base AS runtime
ENV NODE_ENV=production

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=deps /app/packages/auth/node_modules ./packages/auth/node_modules
COPY --from=deps /app/packages/db/node_modules ./packages/db/node_modules
COPY --from=deps /app/apps/api/node_modules ./apps/api/node_modules

COPY package.json pnpm-workspace.yaml ./
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=build /app/packages/auth/dist ./packages/auth/dist
COPY --from=build /app/packages/auth/package.json ./packages/auth/package.json
COPY --from=build /app/packages/db/dist ./packages/db/dist
COPY --from=build /app/packages/db/migrations ./packages/db/migrations
COPY --from=build /app/packages/db/package.json ./packages/db/package.json
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/api/package.json ./apps/api/package.json

# Asset storage directory. Mounted as a volume in compose so uploads survive
# a container restart.
RUN mkdir -p /app/.storage

EXPOSE 4400
CMD ["node", "apps/api/dist/index.js"]
