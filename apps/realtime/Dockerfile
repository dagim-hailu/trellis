# Trellis realtime service.
#
# Same workspace-aware build as the API image; the realtime process needs the
# shared, auth and db packages plus ws/ioredis.

FROM node:24.14.0-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@11.28.5 --activate
WORKDIR /app

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/auth/package.json ./packages/auth/
COPY packages/db/package.json ./packages/db/
COPY apps/api/package.json ./apps/api/
COPY apps/realtime/package.json ./apps/realtime/
COPY apps/web/package.json ./apps/web/
RUN pnpm install --frozen-lockfile --filter @trellis/realtime... --filter @trellis/db... --filter @trellis/shared... --filter @trellis/auth...

FROM deps AS build
COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps/realtime ./apps/realtime
RUN pnpm --filter "./packages/*" run build \
 && pnpm --filter @trellis/realtime run build

FROM base AS runtime
ENV NODE_ENV=production

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=deps /app/packages/auth/node_modules ./packages/auth/node_modules
COPY --from=deps /app/packages/db/node_modules ./packages/db/node_modules
COPY --from=deps /app/apps/realtime/node_modules ./apps/realtime/node_modules

COPY package.json pnpm-workspace.yaml ./
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=build /app/packages/auth/dist ./packages/auth/dist
COPY --from=build /app/packages/auth/package.json ./packages/auth/package.json
COPY --from=build /app/packages/db/dist ./packages/db/dist
COPY --from=build /app/packages/db/migrations ./packages/db/migrations
COPY --from=build /app/packages/db/package.json ./packages/db/package.json
COPY --from=build /app/apps/realtime/dist ./apps/realtime/dist
COPY --from=build /app/apps/realtime/package.json ./apps/realtime/package.json

EXPOSE 4401
CMD ["node", "apps/realtime/dist/index.js"]
