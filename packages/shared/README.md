# @trellis/shared

Browser-safe contracts shared by every workspace package.

- `api.ts` — Zod request schemas and API DTOs
- `roles.ts` — membership roles and role ordering
- `protocol.ts` — WebSocket message IDs, close codes, Redis channel names, Redis envelope schemas
- `canvas.ts` — Yjs canvas node/layer DTOs, canvas constants, hit-testing and color helpers

Build and test:

```bash
pnpm --filter @trellis/shared build
pnpm --filter @trellis/shared test
pnpm --filter @trellis/shared typecheck
```

The package compiles to `dist/` and is consumed by the API, realtime, and web apps. It must remain free of Node-only APIs because `apps/web` imports it in the browser.
