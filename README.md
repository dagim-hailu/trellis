# Trellis

A local-first collaborative design canvas for teams that want the speed of a template-led start and the control of a precise editor. Begin with a reusable template, place shapes, notes, text, frames, images, and comments on an infinite canvas, then refine and share the work together. Edits continue locally when the network drops and converge through Yjs when peers reconnect.

The product is in active development; this README distinguishes shipped workflows from production-hardening work that remains. Yjs owns document convergence, PostgreSQL stores durable updates and snapshots, Redis distributes room events across Node.js realtime processes, and the browser renders on HTML Canvas with IndexedDB persistence.

**Decisions**

- **Rendering:** HTML5 Canvas 2D. The current workload is a flat scene of shapes, text, notes, images, paths, connectors, and frames; Canvas 2D keeps the hot path dependency-free and deterministic across browsers.
- **Theming:** Light, Dark, and Rust (`#B7410E`) are CSS-variable themes persisted per browser; the Canvas renderer consumes matching palettes so the grid, selection chrome, text blocks, and new-object defaults change with the UI.
- **Realtime codec:** the standard y-websocket/y-protocols binary frames are used unchanged, so any Yjs client can interoperate.
- **Authentication:** short-lived HS256 bearer tokens are passed in `Sec-WebSocket-Protocol` (or `Authorization` for non-browser clients), never in a URL.
- **Persistence authority:** compaction is performed from PostgreSQL under a per-document advisory lock, so deleting old incremental updates cannot lose an update that a node missed over Pub/Sub.

---

## 1. Monorepo layout

```text
trellis/
├── apps/
│   ├── web/                         # Next.js App Router client; Canvas renderer, Zustand, y-indexeddb, y-websocket
│   │   ├── src/app/                 # Login/dashboard, template discovery, /documents/[documentId], theme-aware styles
│   │   ├── src/canvas/              # Yjs model, renderer, geometry, controller, local UI state
│   │   ├── src/components/          # Editor, layers, inspector, assets, comments, components, Canvas Compass
│   │   └── src/lib/                 # Typed HTTP client, session handling, endpoint defaults, three-theme palettes
│   ├── api/                         # Fastify HTTP service: auth, workspaces, documents, invitations
│   │   ├── src/routes/              # auth, workspace/document, invitation endpoints
│   │   ├── src/lib/                 # API errors, bearer parsing, validation helpers
│   │   ├── src/app.ts               # Fastify composition, CORS, Helmet, rate limits, error mapping
│   │   ├── src/index.ts             # API process entry point and graceful shutdown
│   │   ├── src/seed.ts              # Idempotent local demo seed
│   │   └── src/__tests__/           # Fastify inject tests
│   └── realtime/                    # Node.js ws service: Yjs rooms, auth, Redis fan-out, Postgres snapshots
│       ├── src/server.ts            # HTTP/WS server, upgrade auth, connection lifecycle
│       ├── src/room-manager.ts      # Reference-counted room lifecycle and reconnect/close ordering
│       ├── src/room.ts              # Y.Doc + Awareness, persistence queue, awareness/presence, snapshots
│       ├── src/protocol.ts          # y-protocols frame parsing/encoding and update validation
│       ├── src/pubsub.ts            # ioredis Pub/Sub adapter with channel reference counts
│       ├── src/index.ts             # Realtime process entry point
│       └── src/__tests__/           # room lifecycle, echo, auth, awareness, sync tests
├── packages/
│   ├── shared/                      # Zoned API DTO/schemas, roles, CRDT canvas contract, Redis envelope schemas
│   ├── auth/                        # scrypt password hashing and access-token issuance/verification
│   └── db/                          # PostgreSQL pool, repositories, update/snapshot store, migrations
│       └── migrations/001_init.sql  # Complete database DDL
├── docs/
│   ├── canvas-contract.md           # Exact Yjs data layout, note nodes, and presence state shape
│   └── operations.md                # Runbook, failure behavior, and hardening backlog
├── docker-compose.yml               # Pin-to-localhost PostgreSQL 17.5 and Redis 7.4.2
├── .env.example                     # Shared configuration template
├── pnpm-workspace.yaml
├── turbo.json
└── tsconfig.base.json
```

Each package has one responsibility:

| Package | Responsibility |
| --- | --- |
| `apps/web` | Browser canvas, local-first Yjs sync, presence UI, authentication entry. |
| `apps/api` | Authenticated control plane for users, workspaces, documents, and invitations. |
| `apps/realtime` | WebSocket Yjs sessions, transient awareness, durable update writes, room-scoped Redis fan-out, compaction scheduling. |
| `packages/shared` | Browser-safe types, Zod schemas, roles, Redis envelopes, and the Yjs canvas data contract. |
| `packages/auth` | Password hashing and signed access-token primitives shared by HTTP and WebSocket services. |
| `packages/db` | SQL access layer, transactional persistence, snapshot compaction, and schema migrations. |

### Data flow

```text
Browser
  │  HTTP (auth/documents/invitations)          ┌──────────────┐
  ├───────────────────────────────────────────▶│ apps/api     │──────┐
  │                                            └──────────────┘      │
  │  WebSocket binary y-protocols                   ┌───────────────┐  │
  ├────────────────────────────────────────────────▶│ apps/realtime │──┼──▶ PostgreSQL
  │       sync / awareness                          └───────┬───────┘  │    (updates,
  │                                                          │          │     snapshots,
  │                                                Redis Pub/Sub        │     authz)
  │                                          ┌───────────────┴──────┐
  └──────── other realtime nodes ◀───────────┤ sync + awareness     │
                                             └──────────────────────┘
```

Yjs updates in the document are opaque to both backends. Postgres stores the bytes and fenced cutoffs; Redis carries already-committed updates and ephemeral awareness only. Presence is never inserted into Postgres.

---

## 2. PostgreSQL schema

The authoritative DDL is **[packages/db/migrations/001_init.sql](packages/db/migrations/001_init.sql)**. The migration runner records SHA-256 checksums in `public.schema_migrations`, takes an advisory lock, and applies each migration in its own transaction.

### Tables and keys

| Table | Purpose | Keys / important indexes |
| --- | --- | --- |
| `app.users` | Account identity and password hash. | PK `id`; unique `email` (`citext`, lower-case check). |
| `app.workspaces` | Tenant boundary. | PK `id`; unique `slug`; FK `created_by`. |
| `app.workspace_memberships` | Role assignments: `owner`, `editor`, `viewer`. | PK `(workspace_id, user_id)`; index `(user_id, workspace_id) INCLUDE (role)`; FKs cascade. |
| `app.documents` | Room identity and metadata. The document UUID is also the Yjs room name. | PK `id`; FK `workspace_id`; partial index `(workspace_id, updated_at DESC) WHERE archived_at IS NULL`. |
| `app.document_updates` | Append-only incremental Yjs update bytes. | Identity PK `id`; index `(document_id, id)`; FK document cascade; 8 MiB payload check. |
| `app.document_snapshots` | Complete Yjs state + state vector at a versioned cutoff. | PK `id`; unique `(document_id, version)`; covering index `(document_id, version DESC) INCLUDE (state, state_vector, through_update_id)`. |
| `app.invitations` | One-time collaborator invitations with hashed tokens. | PK `id`; unique `token_hash`; index `(workspace_id, email, created_at DESC)`; pending-expiry index; FK workspace cascade. |

### Role enforcement in the database

`app.document_role(document_id, user_id)` resolves the effective workspace role. The hard constraint on incremental writes is a **constraint trigger**, not an application check:

```sql
CREATE FUNCTION app.require_editor_for_document_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = app, pg_temp
AS $$
DECLARE
  effective_role app.membership_role;
BEGIN
  SELECT app.document_role(NEW.document_id, NEW.actor_id) INTO effective_role;

  IF effective_role IS NULL OR effective_role NOT IN ('owner', 'editor') THEN
    RAISE EXCEPTION
      'actor % does not have editor access to document %', NEW.actor_id, NEW.document_id
      USING ERRCODE = '42501';
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER document_updates_require_editor
  AFTER INSERT ON app.document_updates
  DEFERRABLE INITIALLY IMMEDIATE
  FOR EACH ROW
  EXECUTE FUNCTION app.require_editor_for_document_update();
```

The realtime write query also joins the membership table and requires `owner|editor`, so authorization is enforced in both the service and the database. Reads are scoped by membership joins in every repository query. API admin operations (invitations) are additionally restricted to `owner`.

Other invariants:

- A workspace always retains at least one owner (`workspace_memberships_require_owner`, deferred).
- Invitations cannot carry the `owner` role; owners cannot be created by invite.
- Snapshot versions are positive and unique per document.
- `through_update_id` is the inclusive high-water mark of updates folded into a snapshot.
- Role changes and permission mutations live in Postgres; no role or permission is stored in Yjs.

### Access matrix

| Operation | Viewer | Editor | Owner |
| --- | --- | --- | --- |
| Read document / connect to room | yes | yes | yes |
| Send awareness (cursor/selection) | yes | yes | yes |
| Append Yjs updates | no (DB trigger + WS close) | yes | yes |
| Create/rename docs | no | yes | yes |
| Invite collaborators | no | no | yes |
| Delete documents | no | no | yes |

---

## 3. Sync protocol

The transport is one WebSocket per client and document at:

```text
ws://<realtime-host>/ws/documents/<documentId>
```

### Authentication

There is no token query parameter. The server accepts either:

```http
Authorization: Bearer <jwt>
```

or, for browser WebSocket providers, a subprotocol list:

```http
Sec-WebSocket-Protocol: trellis.v1, bearer.<jwt>
```

The `trellis.v1` protocol is selected back; the bearer entry is never reflected. The upgrade is rejected with HTTP 401 for missing/invalid/expired tokens, 403 for a disallowed origin or non-member, and 503 if authorization cannot be checked. The database is the source of truth for the role; role claims are not trusted from the token. Upgrade acceptance peeks the room with the same role that the write path will recheck.

### Binary frame format

The standard y-websocket/y-protocols layout is used:

```text
[varUint messageType][payload]
```

| Message | Wire type | Direction | Server action | Path |
| --- | --- | --- | --- | --- |
| Sync step 1 | `0` + sync subtype `0` (state vector) | C→S | Read the requestor's state vector and reply unicast with sync step 2. No DB. | transient |
| Server sync step 1 | `0` + sync subtype `0` | S→C | Sent immediately after join so the client can reply with its offline state. | transient |
| Sync step 2 | `0` + sync subtype `1` (update bytes) | both | Client step 2 is a Yjs update: validate, persist, apply, broadcast, publish to Redis. Server step 2 is a transient response to a client's step 1. | client→server is persistent; server→client is transient |
| Sync update | `0` + sync subtype `2` (update bytes) | C→S then S→all | Same persistent path as client step 2. After commit the server sends the update as subtype `2` locally and publishes it to Redis. | persistent |
| Awareness | `1` + awareness payload | C→S then S→all | Applied to a non-persistent `Awareness` instance, broadcast to local sockets, published on Redis awareness channel. Never written to Postgres. | transient |
| Query awareness | `3` | C→S | Unicast current awareness snapshot. | transient |
| Auth | `2` | — | Not accepted after HTTP upgrade; auth happens in the upgrade. | n/a |

An empty Yjs update (the normal sync handshake response) is validated, recognized, and skipped so it does not create an empty Postgres row. Non-empty updates are applied to a scratch document before write; malformed bytes close with `1003`. Viewer sockets may connect and sync but any `update` frame is rejected with close `4403`; a viewer's handshake step 2 is discarded.

### Persistent update path

```text
client Yjs update
  → parse varUint frame
  → validate size / apply to scratch Y.Doc
  → room writeTail (serial per local document)
  → Postgres transaction:
       pg_advisory_xact_lock(document)
       INSERT document_updates (authorization-enforcing constraint trigger)
       UPDATE documents.updated_at
       COMMIT
  → apply to in-memory Y.Doc
  → broadcast y-protocols update to every socket in this room (including sender; idempotent)
  → publish Redis envelope {originNodeId, updateId, base64 update}
  → receivers on other nodes apply + broadcast locally
```

Redis is deliberately after commit. Other nodes never persist updates; each client update is written exactly once by the node that accepted it. Yjs idempotence makes duplicate application safe on resync.

### Transient path

Awareness frames never touch PostgreSQL. They are validated, applied to the room's `Awareness`, relayed to every local socket, and published as a base64 envelope on the awareness channel. Node receivers apply and relay to their local sockets without republishing. New rooms issue `awareness-sync-request`; peer nodes answer through Redis with their locally-owned presence states, so cross-node presence appears immediately instead of waiting for the next awareness heartbeat.

### Close codes

| Code | Meaning |
| --- | --- |
| `1003` | Invalid/oversized frame or malformed Yjs data. |
| `1011` | Persistence/application failure; reconnect and retry (offline changes remain in IndexedDB). |
| `1012` | Server restart. |
| `1013` | Too many unacknowledged pending writes in the room. |
| `4403` | Role rejected the write / permission revoked. y-websocket stops automatic reconnect for this range. |
| `4409` | Reserved for superseded sessions. |

---

## 4. Redis fan-out design

### Channels

Every room subscribes to exactly two channels, derived from `REDIS_CHANNEL_PREFIX`:

```text
<prefix>:document:<documentId>:sync
<prefix>:document:<documentId>:awareness
```

Channels are per document, not per user or per socket. Updates and presence are separated so awareness can never be mistaken for durable state. Prefixes are validated to be non-empty and colon-free.

### Envelopes

```json
{
  "version": 1,
  "kind": "update",
  "documentId": "…",
  "originNodeId": "host:pid:uuid",
  "publishedAt": 1760000000000,
  "updateId": "1042",
  "actorId": "…",
  "update": "<base64 Yjs update>"
}
```

```json
{
  "version": 1,
  "kind": "awareness",
  "documentId": "…",
  "originNodeId": "host:pid:uuid",
  "publishedAt": 1760000000000,
  "awareness": "<base64 awareness update>"
}
```

A room-open bootstrap message uses `kind: "awareness-sync-request"` and no payload. All envelopes are validated by the shared Zod discriminated union before use.

### Room subscription lifecycle

1. The first local socket for a document asks the `RoomManager` for that document.
2. The manager creates one `RealtimeRoom`, which subscribes to **both** Redis channels *before* loading the latest Postgres state. Envelopes received during hydration are queued, so no gap exists between database load and Pub/Sub subscription.
3. The room hydrates Postgres, applies the snapshot and remaining updates, then drains the queue and issues an awareness snapshot request. Once ready, the first socket is added and receives sync step 1.
4. Additional local sockets reuse the same room/Y.Doc; there is one Redis subscription per channel for the whole local room.
5. When the last socket disconnects, the room is marked closing, both subscriptions are removed, the write queue is drained, a final snapshot is attempted, and the `Y.Doc` is destroyed.
6. A reconnect that races with closure sees `state === "closing"` and waits for teardown before loading a fresh room. This prevents a new room from hydrating before the previous room's final committed write/snapshot is visible.

The Redis adapter uses **separate publisher and subscriber connections**, as required by Redis. Channel handlers are reference-counted inside the adapter; `unsubscribe` is called only after a channel's last room handler is removed. ioredis handles reconnect and subscription restoration; missed messages are recovered by a Yjs resync (the browser requests state every 30 seconds and on every reconnect).

### Avoiding echo and loops

- Every envelope carries `originNodeId`. A room drops any envelope from its own node before parsing further. Redis Pub/Sub normally does not echo a published message to the publishing connection; this guard protects against duplicated subscribers, tests, future transports, and misconfiguration.
- Local updates are broadcast exactly once locally after commit and never re-published when the originating node receives its own envelope.
- Redis-sourced updates are applied and broadcast locally but are never written to Postgres and never re-published. Yjs's idempotent merge handles duplicate delivery.
- Awareness has the same origin rule, and the bootstrap request is answered with an awareness envelope rather than recursively broadcasting a request.

---

## 5. Snapshot and compaction strategy

### When snapshots are attempted

- When a room's applied-update counter reaches `SNAPSHOT_EVERY_UPDATES` (default 200).
- On the `SNAPSHOT_INTERVAL_MS` timer (default 60s) if any updates were applied since the last attempt.
- On the final local client disconnect, after the room's write queue drains.
- Snapshots are idempotent across nodes; concurrent attempts serialize on the same Postgres advisory lock and the loser observes no new updates.

### Compaction transaction

`DocumentStore.compact()` is intentionally **database-sourced**, not based on whichever node's in-memory copy happens to be freshest:

```text
BEGIN
  pg_advisory_xact_lock(hash(documentId))
  verify document exists
  SELECT latest snapshot (state, version, through_update_id)
  SELECT document_updates WHERE document_id = $1 AND id > through_update_id ORDER BY id
  if no new updates: COMMIT and return null
  apply snapshot + every incremental update to a temporary Y.Doc
  state        = Y.encodeStateAsUpdate(doc)
  state_vector = Y.encodeStateVector(doc)
  INSERT document_snapshots (version = previous + 1, state, state_vector, through_update_id=max(id))
  DELETE document_updates WHERE document_id = $1 AND id <= through_update_id
  DELETE old snapshots, retaining the newest SNAPSHOT_RETENTION versions
COMMIT
```

The same advisory lock is taken by `appendUpdate`, `loadForColdStart`, and compaction. No writer can insert an update between the snapshot's SELECT and the corresponding DELETE, and no reader can see a half-pruned log. The load transaction is **READ COMMITTED** on purpose: the advisory-lock statement is the first query and a REPEATABLE READ snapshot would be frozen before waiting for a writer, potentially missing that writer's just-committed update.

### Cold start

```text
BEGIN
  advisory lock(document)
  latest snapshot by version DESC
  document_updates with id > snapshot.through_update_id ORDER BY id ASC
COMMIT
→ apply snapshot state
→ apply each incremental Yjs update
→ broadcast later updates normally
```

This is enough to reconstruct the exact document after a process crash or eviction. Old snapshot versions are retained only for inspection/rollback; only the newest is used for cold start.

### Growth bound

With default settings, updates are compacted at most every 200 applied updates or 60 seconds, and the final room close always attempts one compaction. The update log is therefore bounded by the active-room write rate plus in-flight transactions; snapshots are pruned to five versions per document. If a room never closes and never receives updates, neither table grows.

### Relevant configuration

| Variable | Default | Effect |
| --- | --- | --- |
| `SNAPSHOT_EVERY_UPDATES` | `200` | Dirty-update threshold for snapshot attempts. |
| `SNAPSHOT_INTERVAL_MS` | `60000` | Maximum interval between attempts for an active room. |
| `SNAPSHOT_RETENTION` | `5` | Snapshot versions kept per document. |
| `MAX_UPDATE_BYTES` | `1048576` | Per-frame Yjs update cap; database hard cap is 8 MiB. |

---

## 6. Realtime server skeleton

The complete, runnable implementation is under **[apps/realtime](apps/realtime)**. Entry point: `apps/realtime/src/index.ts`; server composition: `apps/realtime/src/server.ts`.

Key classes:

- **`createRealtimeServer`** — HTTP health/readiness, strict upgrade path/origin/token/authorization checks, `ws` frame dispatch, pause/resume buffering during room load, graceful shutdown.
- **`RoomManager`** — one reference-counted room per document per node; safe reconnect-during-close behavior; disconnect/drain/close ordering.
- **`RealtimeRoom`** — `Y.Doc` + `Awareness`, Redis subscription lifecycle, per-room write serialization, persistent update transaction path, fan-out, awareness cleanup, snapshot threshold/timer/close logic.
- **`RedisPubSub`** — separate ioredis pub/sub connections, reference-counted channel subscriptions, bounded publish retries.
- **`protocol.ts`** — canonical y-protocols parsing/encoding, update validation, awareness client extraction, close-reason normalization.
- **`DocumentStore`** in `packages/db` — advisory-locked append/load/compaction as described above.

Error handling includes: HTTP upgrade rejection before a socket exists; binary-only enforcement; frame size/format validation; Yjs validation before persistence; per-connection close on forbidden/storage mismatch; queue limits; malformed Redis envelope discard; snapshot failure isolation; Redis publish failure logging without rolling back the committed update; structured pino logs; and a 15-second forced graceful-shutdown ceiling.

### Tests

`apps/realtime/src/__tests__/room-manager.test.ts` and `server.test.ts` run without external services by injecting a deterministic store and an intentionally hostile in-memory Pub/Sub bus. They cover:

- load-once, two-channel subscribe, unsubscribe and compaction on last disconnect;
- room reuse across multiple sockets;
- **echo avoidance**: the fake bus reflects node A's own envelope back to node A, and the test asserts exactly one update frame and one Postgres append across two nodes;
- cross-node persistence fan-out and Yjs application;
- auth rejection: missing token (401), malformed token (401), valid token without membership (403), bad origin (403), accepted bearer subprotocol;
- viewer write rejection (4403, no database append);
- y-websocket awareness re-broadcast (no false ownership rejection);
- sync step 1 → step 2 recovery from a stored update.

API tests use Fastify injection and fake repositories. Shared/auth tests cover roles, channel naming, sticky-note hit testing, scrypt, and JWT signing. Web tests include geometry, rendering model round-trips, image handling, component source/instance propagation, and deterministic frame auto-layout.

```bash
pnpm test
pnpm typecheck

# or individually
pnpm --filter @trellis/realtime test
pnpm --filter @trellis/api test
pnpm --filter @trellis/shared test
pnpm --filter @trellis/auth test
pnpm --filter @trellis/web test
```

The verified manual integration runs used the Docker Compose services plus two browser sessions: online convergence, cross-node Redis fan-out with two realtime processes, PostgreSQL-persisted updates, offline drawing through a realtime-server restart, and cold reload recovery.

---

## Canvas workspace capabilities

The web workspace combines a guided entry point with a focused editor:

- **Three themes:** Light, Dark, and Rust, with Dark as the first-run default. Rust is built around `#B7410E` and uses a warm oxidized surface palette. The chosen theme is persisted in `localStorage` and applied before paint to avoid a flash. Theme preference is browser-local (not collaborative content); new objects adopt the active theme's defaults, while existing object colors remain user-authored.
- **Templates:** browse and filter the built-in starter catalog on the dashboard, preview its purpose, and create a document pre-populated with template content.
- **Sticky notes:** a first-class `note` CRDT node with contrast-aware text, a dedicated tool (`N`), double-click/Enter editing, and the same fill/stroke/size/duplicate/delete inspector as other objects.
- **Multi-select and direct manipulation:** shift-click toggles objects, marquee-selection selects intersecting visible objects, group drag moves all selected nodes in one Yjs transaction, and eight resize handles support Shift-constrained proportions. Arrow keys nudge by 1 px, Shift+arrows by 10 px.
- **Keyboard-first editing:** copy/paste/duplicate, select all, delete, undo/redo, space-drag panning, scroll zoom, fit-to-content, reset zoom, and a `?` shortcut sheet.
- **Layer management:** add, rename (double-click or pencil), reorder, hide/show, delete-with-fallback, and move selected objects between layers. Layer changes are regular local Yjs transactions and are undoable.
- **Inspector and frames:** fill swatches and custom colors, text size, stroke width, layer assignment, z-order, and explicit horizontal/vertical frame auto-layout with gap, padding, and alignment controls.
- **Image assets:** upload and browse workspace images, then insert authenticated image nodes into the canvas. Image bytes are loaded with authorized requests and are available to PNG export.
- **Comments:** place anchored comment threads, reply, resolve, and review them in the editor; writes remain role-restricted by the API.
- **Reusable components:** turn selected objects into a document-local component, insert linked instances, and propagate style/text changes from a source object to matching instances. Component properties, variants, and cross-document libraries are not yet included.
- **Canvas Compass:** run local-only preflight checks for missing image references, small text, frame overflow, and unresolved comments; select an affected object or jump to a thread. Checks are advisory and do not send canvas content to an AI service.
- **Viewport and output controls:** zoom controls, percentage reset, fit-all, PNG export of the current canvas view, and copy-canvas-link sharing.
- **Local-only UI state:** cursor motion lives in Zustand and awareness; React does not subscribe to cursor updates. Selection presence is shared through Yjs awareness.

Auto-layout is currently an explicit arrange operation: it positions existing frame children and stores the chosen settings, but does not yet reflow automatically when content or child sizes change. Component definitions and instances are scoped to one document. Full responsive constraints, variants, reusable team libraries, prototype playback, and design-token systems remain future work.

The interaction set follows established patterns for keyboard-driven design tools and large-canvas whiteboards—see Figma's [keyboard controls and shortcut sheet](https://help.figma.com/hc/en-us/articles/360040328653-Use-Figma-products-with-a-keyboard) and Picsart Flow's [canvas organization patterns](https://picsart.com/flow/canvas-organization/) for marquee selection, nodes traveling with selections, copy/paste, and sticky notes.

## Setup and run

### Prerequisites

- Node.js **>= 22.12** (verified on 24.14)
- pnpm **11.28.5** (`corepack prepare pnpm@11.28.5 --activate`)
- Docker Desktop / Docker Engine with Compose for the local PostgreSQL and Redis services

### 1. Install and configure

```bash
# from the repository root
cp .env.example .env
pnpm install
echo "NEXT_PUBLIC_API_URL=http://127.0.0.1:4400" >> apps/web/.env.local
echo "NEXT_PUBLIC_REALTIME_URL=ws://127.0.0.1:4401" >> apps/web/.env.local
```

PowerShell equivalents:

```powershell
Copy-Item .env.example .env
pnpm install
"NEXT_PUBLIC_API_URL=http://127.0.0.1:4400" | Out-File apps/web/.env.local
"NEXT_PUBLIC_REALTIME_URL=ws://127.0.0.1:4401" | Out-File apps/web/.env.local -Append
```

The browser `.env.local` is optional locally because `src/lib/env.ts` has the same defaults. Set it for builds targeting another host. Public endpoints are compiled at Next.js build time.

Change `JWT_SECRET` outside local development. The value in `.env.example` is only a development default.

### 2. Start infrastructure, migrate, seed

```bash
docker compose up -d
pnpm db:migrate
pnpm db:seed
```

This maps PostgreSQL to `127.0.0.1:55432` and Redis to `127.0.0.1:56379` to avoid conflicting with local default ports. The seed is idempotent and prints a document URL and demo credentials on first run:

```text
user:      demo@trellis.local
password:  demo-password-123
```

The seed refuses `NODE_ENV=production` unless `ALLOW_PRODUCTION_SEED=true`.

### 3. Run

```bash
pnpm dev
```

- Web: <http://localhost:3100>
- API: <http://127.0.0.1:4400> (`/healthz`, `/readyz`)
- Realtime: <http://127.0.0.1:4401> (`/healthz`, `/readyz`)

`pnpm dev` first builds `packages/*`, then starts Turborepo persistent tasks: TypeScript watchers for packages plus API/realtime/web dev servers. Open the web app at `localhost` (not `127.0.0.1`) to match the default `WEB_ORIGIN` CORS/origin allowlist.

### Run each app independently

Each app has its own README with its local responsibilities, environment, and commands:

- [apps/api/README.md](apps/api/README.md)
- [apps/realtime/README.md](apps/realtime/README.md)
- [apps/web/README.md](apps/web/README.md)
- [packages/db/README.md](packages/db/README.md)
- [packages/shared/README.md](packages/shared/README.md)
- [packages/auth/README.md](packages/auth/README.md)

```bash
# build shared packages after changing them
pnpm packages:build

pnpm --filter @trellis/api dev
pnpm --filter @trellis/realtime dev
pnpm --filter @trellis/web dev

# tests / type checks
pnpm --filter @trellis/api test
pnpm --filter @trellis/realtime test
pnpm --filter @trellis/api typecheck
pnpm --filter @trellis/realtime typecheck
pnpm --filter @trellis/web typecheck
```

### Production-shaped start

```bash
pnpm build

# set production env first; API and realtime read DATABASE_URL, REDIS_URL, JWT_SECRET, WEB_ORIGIN
pnpm --filter @trellis/api start
pnpm --filter @trellis/realtime start
pnpm --filter @trellis/web start
```

`pnpm build` runs the package builds, TypeScript for both Node services, and `next build`. Put both WebSocket and HTTP traffic behind TLS and a load balancer. WebSocket connections can be routed to any realtime node; Pub/Sub keeps nodes converged.

### Seed/re-run database operations

```bash
pnpm db:migrate      # appends only migrations whose checksums are new
pnpm db:seed         # idempotent local demo account/workspace/document
```

Migration files must not be edited after being applied; `packages/db/src/migrate.ts` fails on checksum drift. Create a new SQL file instead.

---

## API reference

All authenticated routes require `Authorization: Bearer <accessToken>`. Response bodies are JSON. Error shape:

```json
{ "error": { "code": "forbidden", "message": "…", "requestId": "…" } }
```

| Method | Path | Access | Purpose |
| --- | --- | --- | --- |
| `POST` | `/v1/auth/register` | public | Create account; returns token + user. |
| `POST` | `/v1/auth/login` | public | Issue access token. |
| `GET` | `/v1/me` | auth | Current user. |
| `GET` | `/v1/workspaces` | auth | Workspaces for the user. |
| `POST` | `/v1/workspaces` | auth | Create workspace; caller becomes owner. |
| `GET` | `/v1/workspaces/:id` | member | Workspace metadata and caller's role. |
| `GET` | `/v1/workspaces/:id/members` | member | Membership list. |
| `GET` | `/v1/workspaces/:id/documents` | member | Documents in the workspace. |
| `POST` | `/v1/workspaces/:id/documents` | editor/owner | Create a document/canvas. |
| `GET` | `/v1/templates` | auth | List built-in starter templates. |
| `POST` | `/v1/workspaces/:id/documents/from-template` | editor/owner | Create a document seeded from a template. |
| `GET` | `/v1/documents/:id` | member | Document metadata and caller role. |
| `PATCH` | `/v1/documents/:id` | editor/owner | Rename document. |
| `DELETE` | `/v1/documents/:id` | owner | Delete document plus updates/snapshots. |
| `GET` | `/v1/workspaces/:id/assets` | member | List workspace image assets. |
| `POST` | `/v1/workspaces/:id/assets/upload-intent` | editor/owner | Create an authenticated upload target. |
| `PUT` | `/v1/workspaces/:id/assets/upload/:storageKey` | editor/owner | Upload image bytes for the target. |
| `POST` | `/v1/workspaces/:id/assets/confirm` | editor/owner | Verify and register uploaded asset metadata. |
| `GET` | `/v1/assets/:assetId/content` | member | Read protected image content. |
| `GET` | `/v1/documents/:id/comments` | member | List anchored comments and replies. |
| `POST` | `/v1/documents/:id/comments` | editor/owner | Create a comment thread or reply. |
| `PATCH` | `/v1/comments/:commentId/resolve` | member | Resolve or reopen a comment. |
| `DELETE` | `/v1/comments/:commentId` | author/owner | Delete a comment. |
| `POST` | `/v1/workspaces/:id/invitations` | owner | Create one-time invite; raw token returned once. |
| `POST` | `/v1/invitations/accept` | auth | Accept invite with `{ "token": "…" }`; email must match. |

Invitation example:

```bash
TOKEN="$(curl -s http://127.0.0.1:4400/v1/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"demo@trellis.local","password":"demo-password-123"}' | jq -r .accessToken)"

curl -s http://127.0.0.1:4400/v1/workspaces/<workspaceId>/invitations \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"email":"grace@example.com","role":"editor","expiresInHours":24}' | jq .
```

The raw invitation token is present only in this creation response; only its SHA-256 hash is stored. Invitation acceptance and management remain API workflows; the current web UI does not provide a separate invitation-management screen.

---

## Environment reference

| Variable | Used by | Notes |
| --- | --- | --- |
| `DATABASE_URL` | API, realtime, db migrations | PostgreSQL connection string. |
| `REDIS_URL` | realtime | Redis server. Pub/Sub is intentionally non-persistent. |
| `JWT_SECRET` | API, realtime | >=32 chars; shared signing/verification secret. |
| `JWT_ISSUER`, `JWT_AUDIENCE` | API, realtime | Must match exactly. |
| `ACCESS_TOKEN_TTL_SECONDS` | API | Token lifetime, default 3600. |
| `WEB_ORIGIN` | API, realtime | Exact browser origin allowed by CORS and WS upgrades. |
| `API_HOST`, `API_PORT` | API | Defaults `127.0.0.1:4400`. |
| `REALTIME_HOST`, `REALTIME_PORT` | realtime | Defaults `127.0.0.1:4401`. |
| `REDIS_CHANNEL_PREFIX` | realtime | Channel namespace; default `trellis`. |
| `MAX_UPDATE_BYTES` | realtime | Application cap per Yjs update. |
| `SNAPSHOT_EVERY_UPDATES`, `SNAPSHOT_INTERVAL_MS`, `SNAPSHOT_RETENTION` | realtime | Compaction policy. |
| `AUTH_TIMEOUT_MS` | realtime | Cap for token/membership lookup during upgrade. |
| `NODE_ID` | realtime | Optional stable node identity for Redis envelopes. |
| `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_REALTIME_URL` | web | Build-time public endpoints. |
| `SEED_EMAIL`, `SEED_PASSWORD`, `SEED_DISPLAY_NAME` | API seed | Local seed overrides. |

---

## Production hardening flags

These are intentionally out of scope for this implementation; they are the first changes a production deployment should make.

1. **Access-token lifecycle.** Tokens are one-hour bearer tokens with no refresh, rotation, or server-side revocation, and the realtime server does not terminate an established socket when its token expires. Add a refresh-token/session table with rotation and reuse detection, a revocation check on reconnect, and a periodic token-expiry cutoff for live sockets.
2. **Redis Pub/Sub delivery guarantees.** Pub/Sub is at-most-once. If a publish fails or a node misses an envelope, live clients on that node can be temporarily stale until the next Yjs resync or reconnect; the durable store remains correct. Add a Postgres outbox with sequence numbers and gap detection, then force a room resync when a gap is observed.

The update log itself is bounded by the compaction strategy above; failed compaction only delays pruning and never discards pending updates.

---

## Canvas document contract

The full contract is in **[docs/canvas-contract.md](docs/canvas-contract.md)**. Short version:

- `doc.getMap("nodes")` is a `Y.Map<Y.Map>` keyed by UUID. Nodes include rectangles, ellipses, text, notes, paths, images, connectors, and frames, with additive optional fields for component links, frame ownership, and layout settings.
- `doc.getMap("layers")` is a `Y.Map<Y.Map>` keyed by layer id, with `name`, `visible`, `zIndex`.
- `doc.getMap("components")` is a `Y.Map<Y.Map>` keyed by document-local component id. It stores a name and source node ids; instances retain a source-node link so shared edits can propagate.
- `provider.awareness` carries `user: {id, name, color}`, `cursor: {x,y}|null`, and `selection: string[]`. It is never persisted.
- The renderer sorts by visible layer zIndex, then node zIndex. All shapes and sticky notes are painted onto one Canvas; React only manages the shell, tool palette, inspector, and the single text-edit dialog.
- Multi-selection is transient UI state plus all selected ids in awareness. Drag moves every selected node in one Yjs transaction; resizing is a local direct-manipulation overlay. Selection styling is painted, not DOM.

The editor is a local-first canvas, not a feature-complete replacement for Figma or Canva. The next production priorities remain access-token refresh/revocation and reliable Pub/Sub delivery with an outbox and gap detection. See the production-hardening list above before deploying to production.

---

## Troubleshooting

- **`/readyz` returns 503:** check `pnpm db:migrate`, Docker container health, and `DATABASE_URL`; the realtime readiness also requires Redis.
- **Login works but requests return 403:** `WEB_ORIGIN` must exactly match the browser origin (`http://localhost:3100`).
- **WebSocket upgrade 401:** use a fresh access token; tokens are passed in `Sec-WebSocket-Protocol` as `bearer.<jwt>` (browser) or `Authorization` (scripts).
- **WebSocket closes 4403:** the user is a viewer or lost editor access. Reconnect after the role is updated.
- **No presence across nodes:** verify both realtime processes use the same `REDIS_URL` and `REDIS_CHANNEL_PREFIX`.
- **Snapshot not appearing:** snapshots trigger on threshold/interval/last-disconnect; inspect `app.document_updates` and logs from `document snapshot written`.
