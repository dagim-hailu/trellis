# @trellis/realtime

Node.js WebSocket server for Yjs rooms.

## Responsibilities

- Upgrade authentication (bearer token + membership/role lookup in PostgreSQL)
- Per-document `Y.Doc` lifecycle and local socket fan-out
- Transient awareness/presence
- Persist client Yjs updates through `@trellis/db`
- Redis Pub/Sub fan-out to other realtime nodes
- Threshold/interval/close snapshot scheduling

## Run

From repository root (after `pnpm packages:build`):

```bash
pnpm --filter @trellis/realtime dev
# or
pnpm --filter @trellis/realtime build
pnpm --filter @trellis/realtime start
```

Environment comes from the repository `.env` when run through the root scripts; see `.env.example`. Required values include `DATABASE_URL`, `REDIS_URL`, `JWT_SECRET`, and `WEB_ORIGIN`.

Health endpoints are served on `REALTIME_HOST:REALTIME_PORT`: `/healthz` and `/readyz`.

## Tests

```bash
pnpm --filter @trellis/realtime test
```

The tests are self-contained (no Postgres/Redis required). They use fake store, socket, and hostile Pub/Sub buses to prove:

- room lifecycle and channel cleanup;
- exactly-once local fan-out despite an echo from the fake bus;
- cross-node durable update propagation;
- sync recovery from stored state;
- rejected WebSocket upgrades for missing/invalid tokens, missing membership, and bad origins;
- viewer write rejection;
- y-websocket awareness re-broadcast handling.

The manual end-to-end verification used the real Docker stack with two realtime processes, two browser contexts, an offline edit, a server restart, and cold reload. See the root README for setup.

## Entry points

- `src/index.ts` — process bootstrap, Redis connection, readiness, signal handling.
- `src/server.ts` — HTTP + upgrade handling, auth, socket session wiring.
- `src/room-manager.ts` — room reference counting and lifecycle.
- `src/room.ts` — Yjs room state, write path, awareness, compaction triggers.
- `src/pubsub.ts` — ioredis adapter.
- `src/protocol.ts` — protocol codec.
