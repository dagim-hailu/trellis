-- Trellis initial schema.
-- All application objects live in the "app" schema. The runtime database user
-- needs SELECT/INSERT/UPDATE/DELETE on these tables; migrations use the owner.

CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE SCHEMA IF NOT EXISTS app;

CREATE TYPE app.membership_role AS ENUM ('owner', 'editor', 'viewer');

CREATE TABLE app.users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         citext NOT NULL,
  password_hash text NOT NULL,
  display_name  text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_email_normalized CHECK (email = lower(email::text)::citext),
  CONSTRAINT users_email_length CHECK (char_length(email::text) BETWEEN 3 AND 254),
  CONSTRAINT users_display_name_length CHECK (char_length(btrim(display_name)) BETWEEN 1 AND 80)
);

CREATE UNIQUE INDEX users_email_key ON app.users (email);

CREATE TABLE app.workspaces (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  slug       citext NOT NULL,
  created_by uuid NOT NULL REFERENCES app.users (id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workspaces_name_length CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  CONSTRAINT workspaces_slug_format CHECK (slug::text ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$')
);

CREATE UNIQUE INDEX workspaces_slug_key ON app.workspaces (slug);

CREATE TABLE app.workspace_memberships (
  workspace_id uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES app.users (id) ON DELETE CASCADE,
  role         app.membership_role NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);

CREATE INDEX workspace_memberships_user_idx
  ON app.workspace_memberships (user_id, workspace_id)
  INCLUDE (role);

CREATE TABLE app.documents (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  title       text NOT NULL,
  created_by  uuid NOT NULL REFERENCES app.users (id) ON DELETE RESTRICT,
  archived_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT documents_title_length CHECK (char_length(btrim(title)) BETWEEN 1 AND 160)
);

CREATE INDEX documents_workspace_updated_idx
  ON app.documents (workspace_id, updated_at DESC)
  WHERE archived_at IS NULL;

CREATE TABLE app.document_updates (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  document_id uuid NOT NULL REFERENCES app.documents (id) ON DELETE CASCADE,
  actor_id    uuid NOT NULL REFERENCES app.users (id) ON DELETE RESTRICT,
  update      bytea NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT document_updates_payload_size CHECK (octet_length(update) BETWEEN 1 AND 8388608)
);

CREATE INDEX document_updates_document_id_idx
  ON app.document_updates (document_id, id);

CREATE TABLE app.document_snapshots (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id       uuid NOT NULL REFERENCES app.documents (id) ON DELETE CASCADE,
  version           bigint NOT NULL,
  state             bytea NOT NULL,
  state_vector      bytea NOT NULL,
  through_update_id bigint NOT NULL,
  created_by        uuid REFERENCES app.users (id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT document_snapshots_version_positive CHECK (version > 0),
  CONSTRAINT document_snapshots_cutoff_nonnegative CHECK (through_update_id >= 0),
  CONSTRAINT document_snapshots_state_size CHECK (octet_length(state) BETWEEN 1 AND 268435456),
  CONSTRAINT document_snapshots_state_vector_size CHECK (octet_length(state_vector) BETWEEN 1 AND 8388608),
  UNIQUE (document_id, version)
);

-- The unique (document_id, version) index also serves "latest snapshot"
-- lookups by scanning it backwards. A secondary partial covering index keeps
-- the cold-start query fully index-only on large deployments.
CREATE INDEX document_snapshots_latest_idx
  ON app.document_snapshots (document_id, version DESC)
  INCLUDE (state, state_vector, through_update_id);

CREATE TABLE app.invitations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  email       citext NOT NULL,
  role        app.membership_role NOT NULL,
  token_hash  text NOT NULL,
  invited_by  uuid NOT NULL REFERENCES app.users (id) ON DELETE RESTRICT,
  expires_at  timestamptz NOT NULL,
  accepted_at timestamptz,
  revoked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT invitations_role_limited CHECK (role IN ('editor', 'viewer')),
  CONSTRAINT invitations_email_normalized CHECK (email = lower(email::text)::citext),
  CONSTRAINT invitations_expiry_after_creation CHECK (expires_at > created_at)
);

CREATE UNIQUE INDEX invitations_token_hash_key ON app.invitations (token_hash);
CREATE INDEX invitations_workspace_email_idx
  ON app.invitations (workspace_id, email, created_at DESC);
CREATE INDEX invitations_pending_expiry_idx
  ON app.invitations (expires_at)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;

-- ---------------------------------------------------------------------------
-- Authorization is enforced in the database, not only in the HTTP/WS layers.
-- The constraint trigger is deferred to the end of the statement and rejects
-- any incremental update whose actor is not currently owner/editor in the
-- document's workspace. Viewers therefore cannot write even if an application
-- bug bypasses route-level checks.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.document_role(p_document_id uuid, p_user_id uuid)
RETURNS app.membership_role
LANGUAGE sql
STABLE
SET search_path = app, pg_temp
AS $$
  SELECT m.role
  FROM app.documents d
  JOIN app.workspace_memberships m ON m.workspace_id = d.workspace_id
  WHERE d.id = p_document_id
    AND m.user_id = p_user_id
    AND d.archived_at IS NULL
$$;

CREATE OR REPLACE FUNCTION app.can_edit_document(p_document_id uuid, p_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = app, pg_temp
AS $$
  SELECT app.document_role(p_document_id, p_user_id) IN ('owner', 'editor')
$$;

CREATE OR REPLACE FUNCTION app.require_editor_for_document_update()
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

-- A workspace must always retain at least one owner. The constraint is
-- deferrable so ownership transfers can occur inside one transaction.
CREATE OR REPLACE FUNCTION app.require_workspace_owner()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = app, pg_temp
AS $$
DECLARE
  target_workspace uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    target_workspace := OLD.workspace_id;
  ELSE
    target_workspace := NEW.workspace_id;
  END IF;

  -- A cascaded workspace deletion removes the workspace first; do not block it.
  IF NOT EXISTS (SELECT 1 FROM app.workspaces WHERE id = target_workspace) THEN
    RETURN NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM app.workspace_memberships
    WHERE workspace_id = target_workspace AND role = 'owner'
  ) THEN
    RAISE EXCEPTION 'workspace % must retain at least one owner', target_workspace
      USING ERRCODE = '23514';
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER workspace_memberships_require_owner
  AFTER DELETE OR UPDATE OF role, workspace_id ON app.workspace_memberships
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION app.require_workspace_owner();

-- Keep updated_at honest for metadata tables. Document update timestamps are
-- advanced explicitly by the append-update transaction.
CREATE OR REPLACE FUNCTION app.touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER users_touch_updated_at
  BEFORE UPDATE ON app.users
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

CREATE TRIGGER workspaces_touch_updated_at
  BEFORE UPDATE ON app.workspaces
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

CREATE TRIGGER workspace_memberships_touch_updated_at
  BEFORE UPDATE ON app.workspace_memberships
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

CREATE TRIGGER documents_touch_updated_at
  BEFORE UPDATE ON app.documents
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

COMMENT ON TABLE app.document_updates IS
  'Append-only Yjs incremental updates. Rows are deleted only after a complete snapshot includes them.';
COMMENT ON TABLE app.document_snapshots IS
  'Full Yjs state snapshots. through_update_id is the highest document_updates.id included.';
COMMENT ON FUNCTION app.require_editor_for_document_update() IS
  'Database-level role check for all persistent CRDT writes.';
