# @trellis/db

PostgreSQL access layer and migrations shared by the API and realtime services.

## Contents

- `migrations/001_init.sql` — complete DDL (users, workspaces, memberships, documents, Yjs updates, snapshots, invitations, authorization trigger)
- `src/client.ts` — pool creation, transaction helper, advisory-lock helper
- `src/document-store.ts` — cold-start hydration, authorized append, DB-sourced compaction
- `src/workspace-repository.ts` — workspace/document/invitation queries
- `src/auth-repository.ts` — user queries
- `src/migrate.ts` — checksum-verified, advisory-locked migration runner

## Migrate

```bash
# from repository root, with DATABASE_URL in .env
pnpm db:migrate
```

Migrations are immutable once applied. The runner records filename + SHA-256 checksum in `public.schema_migrations`; changing an applied file is detected and rejected.

## Test / build

`packages/db` has no direct test script beyond type/build; transactional behavior is covered through the realtime fake-store contract tests and was verified against the Docker PostgreSQL stack. Run `pnpm --filter @trellis/db build`.

## Notes

All update-log mutations use `pg_advisory_xact_lock(hashtextextended(documentId, 0))`. Reads of persisted content join workspace memberships; writes are additionally blocked for viewers by the `document_updates_require_editor` constraint trigger. See the root README for the full schema explanation.
