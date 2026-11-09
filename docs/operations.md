# Operations runbook

## Local topology

| Service | Address | Health |
| --- | --- | --- |
| Web | `http://localhost:3100` | page |
| API | `http://127.0.0.1:4400` | `GET /healthz`, `GET /readyz` |
| Realtime | `http://127.0.0.1:4401` | `GET /healthz`, `GET /readyz` |
| PostgreSQL | `127.0.0.1:55432` | `pg_isready` in container |
| Redis | `127.0.0.1:56379` | `redis-cli ping` |

`/healthz` is a process liveness check. `/readyz` for the API pings PostgreSQL; realtime readiness checks both PostgreSQL and Redis.

## Normal startup

```bash
docker compose up -d
pnpm db:migrate
pnpm db:seed      # first local run, idempotent
pnpm dev
```

The root `dev` script builds the three shared packages and starts package watchers plus all three applications. If the web app ever displays stale shared types, stop and rerun `pnpm packages:build && pnpm dev`.

## Production process order

1. Provision PostgreSQL and Redis.
2. Set environment variables (`DATABASE_URL`, `REDIS_URL`, `JWT_SECRET`, `WEB_ORIGIN`, public URL variables for the Next build).
3. Run `pnpm db:migrate` once per deployment.
4. Start one or more API instances. The API is stateless apart from PostgreSQL.
5. Start one or more realtime instances. They are stateless apart from PostgreSQL and Redis Pub/Sub and can be placed behind a TCP/WebSocket load balancer.
6. Build the web app with production public URLs and serve it with `pnpm --filter @trellis/web start` or your normal Next.js deployment.
7. Terminate connections gracefully. Realtime drains room writes, attempts final snapshots, then closes.

### TLS and origin

Terminate TLS in front of both HTTP and WebSocket endpoints. Set `WEB_ORIGIN` to the exact browser scheme/host/port. The realtime server rejects a browser upgrade when the `Origin` header exists and does not match. The API applies the same origin for CORS. Native clients without an Origin header can still connect with a valid bearer token.

### Scaling

- Every WebSocket node subscribes to the same two channels per active document.
- Any node may create the room; there is no room ownership.
- Postgres advisory locks coordinate all mutations of a document's update log.
- Pub/Sub is not retained. Yjs sync on reconnect and the 30-second provider resync are the current gap-recovery mechanism.
- The API is safe to scale horizontally, but rate limiting is in-process (per instance).

## Failure behavior

| Failure | Behavior |
| --- | --- |
| Browser loses network | Provider disconnects; local Yjs changes persist through y-indexeddb; reconnect does a state-vector exchange. |
| Realtime process dies | Clients reconnect to another node; cold room hydrates latest snapshot + update rows. |
| Redis unavailable | Readiness fails; new room setup fails cleanly; existing updates still commit locally but remote live fan-out can be missed until reconnect. |
| Postgres unavailable | Updates are not applied or fanned out; the affected socket closes 1011 and retains offline state locally. Snapshot failures are logged and retried later. |
| Snapshot compaction fails | Update rows are retained. Correctness is unaffected; only storage pruning is delayed. |
| Invalid Yjs frame | Connection closes 1003 with a bounded reason; other clients are unaffected. |
| Viewer writes | Database constraint rejects; connection closes 4403. |

## Verification queries

```sql
-- rooms and their persisted shape
SELECT d.id, d.title,
       count(DISTINCT u.id) AS pending_updates,
       max(s.version)       AS latest_snapshot_version
FROM app.documents d
LEFT JOIN app.document_updates u ON u.document_id = d.id
LEFT JOIN app.document_snapshots s ON s.document_id = d.id
GROUP BY d.id
ORDER BY d.updated_at DESC;

-- recent snapshot cutoffs
SELECT document_id, version, through_update_id, octet_length(state) AS state_bytes, created_at
FROM app.document_snapshots
ORDER BY created_at DESC
LIMIT 10;
```

Expected steady state after an idle room closes: zero or a small number of pending updates, a new snapshot version, and only the five newest snapshot versions per document.

## Token and invite handling

- Access tokens expire after `ACCESS_TOKEN_TTL_SECONDS` (default one hour). The browser displays a sign-in redirect when the local expiry timer fires.
- Invitations are one-time and stored as SHA-256 hashes. The raw token is returned only from the create-invitation call; do not log or persist it client-side beyond the acceptance flow.
- The seed refuses production unless explicitly overridden.

## Known production hardening backlog

1. Refresh-token rotation/revocation and live-socket expiry enforcement.
2. Durable outbox / sequence-gap detection around Redis Pub/Sub.

See the root README for the rationale.
