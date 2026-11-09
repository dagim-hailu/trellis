# @trellis/api

Fastify control plane for Trellis.

## Responsibilities

- Registration/login and access-token issuance (`@trellis/auth`)
- Workspaces, membership summaries, documents
- One-time invitations (hashed token storage, email-bound acceptance)
- Readiness and error envelopes
- CORS, Helmet, global/burst rate limits

The API never stores canvas content itself. Document content is written by the realtime service.

## Run

```bash
pnpm --filter @trellis/api dev
# or
pnpm --filter @trellis/api build
pnpm --filter @trellis/api start
```

Required env: `DATABASE_URL`, `JWT_SECRET`; see `.env.example` for the complete list.

Seed the local demo account (idempotent):

```bash
pnpm db:seed
```

## Test

```bash
pnpm --filter @trellis/api test
```

Fastify inject tests cover unauthenticated access, login/current-user flow, malformed request handling, and user-scoped workspace listing. The manual integration test also exercised registration, owner invitations, viewer/editor acceptance, and database-level write rejection.

## Endpoints

See the root README's API reference. Health: `/healthz` (liveness), `/readyz` (PostgreSQL ping).
