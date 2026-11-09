-- Trellis canvas enhancements: asset library and pinned canvas comments.
--
-- This migration is additive only. No existing column, constraint, index or
-- trigger from 001_init.sql is altered, so a running deployment can apply it
-- while serving traffic: both new tables start empty, every ADD is a CREATE,
-- and no table rewrite or long lock is taken.
--
-- Note on CONCURRENTLY: the indexes below are plain CREATE INDEX on purpose.
-- The migration runner wraps each file in a single transaction, and
-- CREATE INDEX CONCURRENTLY cannot run inside a transaction block. On tables
-- with zero rows the plain form takes no meaningful lock and builds instantly,
-- so CONCURRENTLY would buy nothing and would break the runner. Do not
-- "fix" this later.

-- ---------------------------------------------------------------------------
-- app.assets
--
-- Metadata for uploaded binary assets (images used by canvas image nodes).
-- The bytes themselves live in object storage; storage_key is the opaque
-- locator and public_url is the URL the browser renders from. Both are
-- generated server-side and never accepted from a client.
-- ---------------------------------------------------------------------------

CREATE TABLE app.assets (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  created_by   uuid NOT NULL REFERENCES app.users (id) ON DELETE CASCADE,
  mime_type    text NOT NULL,
  byte_size    bigint NOT NULL,
  storage_key  text NOT NULL,
  public_url   text NOT NULL,
  width        integer,
  height       integer,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT assets_byte_size_range CHECK (byte_size BETWEEN 1 AND 26214400),
  CONSTRAINT assets_mime_type_allowed CHECK (
    mime_type IN ('image/png', 'image/jpeg', 'image/svg+xml', 'image/webp')
  ),
  CONSTRAINT assets_storage_key_unique UNIQUE (storage_key),
  CONSTRAINT assets_dimensions_positive CHECK (
    (width IS NULL OR width > 0) AND (height IS NULL OR height > 0)
  )
);

COMMENT ON TABLE app.assets IS
  'Uploaded binary assets (canvas images). Bytes live in object storage; this table holds metadata only.';

-- Workspace asset browser: newest first.
CREATE INDEX assets_workspace_created_idx
  ON app.assets (workspace_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- app.document_comments
--
-- Pinned canvas comments anchored at a world-space coordinate. Comments are
-- control-plane data, not CRDT data: they are authored by a single user and
-- never merged, so they belong in Postgres rather than in the Yjs document.
--
-- parent_comment_id provides one level of threading (replies). It is a plain
-- self-reference with ON DELETE CASCADE so deleting a root comment removes its
-- replies without a second statement.
-- ---------------------------------------------------------------------------

CREATE TABLE app.document_comments (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id       uuid NOT NULL REFERENCES app.documents (id) ON DELETE CASCADE,
  author_id         uuid NOT NULL REFERENCES app.users (id) ON DELETE CASCADE,
  parent_comment_id uuid REFERENCES app.document_comments (id) ON DELETE CASCADE,
  x                 double precision NOT NULL,
  y                 double precision NOT NULL,
  content           text NOT NULL,
  resolved          boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT document_comments_content_length CHECK (char_length(content) BETWEEN 1 AND 4000),
  CONSTRAINT document_comments_coordinates_finite CHECK (
    x <> 'Infinity'::double precision AND x <> '-Infinity'::double precision
    AND y <> 'Infinity'::double precision AND y <> '-Infinity'::double precision
  ),
  CONSTRAINT document_comments_no_self_parent CHECK (parent_comment_id IS NULL OR parent_comment_id <> id)
);

COMMENT ON TABLE app.document_comments IS
  'Pinned canvas comments. Threaded one level via parent_comment_id. Never stored in Yjs.';

-- Comment panel: fetch a document's comments filtered by resolution state.
CREATE INDEX document_comments_document_resolved_idx
  ON app.document_comments (document_id, resolved);

-- Reply lookup for a thread.
CREATE INDEX document_comments_parent_idx
  ON app.document_comments (parent_comment_id)
  WHERE parent_comment_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- updated_at maintenance
--
-- app.touch_updated_at() is defined in 001_init.sql and is reused as-is.
-- app.assets has no updated_at column (assets are immutable once confirmed),
-- so only document_comments gets a trigger.
-- ---------------------------------------------------------------------------

CREATE TRIGGER document_comments_touch_updated_at
  BEFORE UPDATE ON app.document_comments
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Authorization helpers
--
-- Mirrors the 001_init.sql philosophy: the database, not only the route
-- handler, is the authority. These are used by the comment and asset routes
-- and are available to future constraint triggers.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.workspace_role(p_workspace_id uuid, p_user_id uuid)
RETURNS app.membership_role
LANGUAGE sql
STABLE
SET search_path = app, pg_temp
AS $$
  SELECT m.role
  FROM app.workspace_memberships m
  WHERE m.workspace_id = p_workspace_id
    AND m.user_id = p_user_id
$$;

COMMENT ON FUNCTION app.workspace_role(uuid, uuid) IS
  'Effective workspace role for a user, or NULL when not a member.';
