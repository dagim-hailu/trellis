# Trellis web (Next.js) service.
#
# NEXT_PUBLIC_* values are inlined at build time, so they are build args here.
# They must be the URLs the BROWSER can reach (localhost), not the compose
# service names, because the browser runs on the host.

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
RUN pnpm install --frozen-lockfile --filter @trellis/web... --filter @trellis/shared...

FROM deps AS build
ARG NEXT_PUBLIC_API_URL=http://localhost:4400
ARG NEXT_PUBLIC_REALTIME_URL=ws://localhost:4401
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_REALTIME_URL=$NEXT_PUBLIC_REALTIME_URL
ENV NEXT_TELEMETRY_DISABLED=1

COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps/web ./apps/web
RUN pnpm --filter "./packages/*" run build \
 && pnpm --filter @trellis/web run build

FROM base AS runtime
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=deps /app/apps/web/node_modules ./apps/web/node_modules

COPY package.json pnpm-workspace.yaml ./
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=build /app/apps/web/.next ./apps/web/.next
COPY --from=build /app/apps/web/package.json ./apps/web/package.json
COPY --from=build /app/apps/web/next.config.ts ./apps/web/next.config.ts
COPY --from=build /app/apps/web/src ./apps/web/src
COPY --from=build /app/apps/web/tsconfig.json ./apps/web/tsconfig.json
COPY --from=build /app/apps/web/next-env.d.ts ./apps/web/next-env.d.ts

EXPOSE 3100
WORKDIR /app/apps/web
# Invoke the Next binary directly. Running through `pnpm run start` makes pnpm
# re-verify the workspace lockfile at runtime, and the runtime image
# intentionally carries only the package.json files it needs, so pnpm reports a
# broken lockfile and tries to re-resolve. The binary is already installed.
CMD ["node", "node_modules/next/dist/bin/next", "start", "-p", "3100"]
