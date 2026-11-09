import type { MembershipRole } from "@trellis/shared";

import { withTransaction } from "./client.js";
import { ConflictError, ForbiddenError, InvalidTokenError, NotFoundError, isPgUniqueViolation } from "./errors.js";
import {
  toDocumentRecord,
  toInvitationRecord,
  toWorkspaceRecord,
  type DocumentRecord,
  type DocumentRow,
  type InvitationRecord,
  type InvitationRow,
  type WorkspaceRecord,
  type WorkspaceRow,
} from "./rows.js";
import type { Pool } from "pg";

export interface WorkspaceMemberRecord {
  userId: string;
  email: string;
  displayName: string;
  role: MembershipRole;
  joinedAt: string;
}

export class WorkspaceRepository {
  constructor(private readonly pool: Pool) {}

  async listWorkspaces(userId: string): Promise<WorkspaceRecord[]> {
    const result = await this.pool.query<WorkspaceRow>(
      `SELECT w.id, w.name, w.slug, w.created_at, m.role
       FROM app.workspace_memberships m
       JOIN app.workspaces w ON w.id = m.workspace_id
       WHERE m.user_id = $1
       ORDER BY w.created_at ASC`,
      [userId],
    );
    return result.rows.map(toWorkspaceRecord);
  }

  async getWorkspace(workspaceId: string, userId: string): Promise<WorkspaceRecord | null> {
    const result = await this.pool.query<WorkspaceRow>(
      `SELECT w.id, w.name, w.slug, w.created_at, m.role
       FROM app.workspaces w
       JOIN app.workspace_memberships m ON m.workspace_id = w.id
       WHERE w.id = $1 AND m.user_id = $2`,
      [workspaceId, userId],
    );
    const row = result.rows[0];
    return row ? toWorkspaceRecord(row) : null;
  }

  async createWorkspace(input: {
    ownerId: string;
    name: string;
    slug: string;
  }): Promise<WorkspaceRecord> {
    try {
      return await withTransaction(this.pool, async (client) => {
        const result = await client.query<WorkspaceRow>(
          `INSERT INTO app.workspaces (name, slug, created_by)
           VALUES ($1, $2, $3)
           RETURNING id, name, slug, created_at,
                     'owner'::app.membership_role AS role`,
          [input.name, input.slug, input.ownerId],
        );
        const workspace = result.rows[0];
        if (!workspace) throw new Error("Workspace insert returned no row");

        await client.query(
          `INSERT INTO app.workspace_memberships (workspace_id, user_id, role)
           VALUES ($1, $2, 'owner')`,
          [workspace.id, input.ownerId],
        );

        return toWorkspaceRecord(workspace);
      });
    } catch (error) {
      if (isPgUniqueViolation(error)) {
        throw new ConflictError("That workspace URL is already taken");
      }
      throw error;
    }
  }

  async listMembers(workspaceId: string, userId: string): Promise<WorkspaceMemberRecord[]> {
    const role = await this.requireWorkspaceRole(workspaceId, userId, "viewer");
    void role;
    const result = await this.pool.query<{
      user_id: string;
      email: string;
      display_name: string;
      role: MembershipRole;
      joined_at: Date;
    }>(
      `SELECT m.user_id, u.email, u.display_name, m.role, m.created_at AS joined_at
       FROM app.workspace_memberships m
       JOIN app.users u ON u.id = m.user_id
       WHERE m.workspace_id = $1
       ORDER BY
         CASE m.role WHEN 'owner' THEN 0 WHEN 'editor' THEN 1 ELSE 2 END,
         u.display_name ASC`,
      [workspaceId],
    );
    return result.rows.map((row) => ({
      userId: row.user_id,
      email: row.email,
      displayName: row.display_name,
      role: row.role,
      joinedAt: row.joined_at.toISOString(),
    }));
  }

  async listDocuments(workspaceId: string, userId: string): Promise<DocumentRecord[]> {
    await this.requireWorkspaceRole(workspaceId, userId, "viewer");
    const result = await this.pool.query<DocumentRow>(
      `SELECT d.id, d.workspace_id, d.title, d.created_at, d.updated_at, m.role
       FROM app.documents d
       JOIN app.workspace_memberships m
         ON m.workspace_id = d.workspace_id AND m.user_id = $2
       WHERE d.workspace_id = $1 AND d.archived_at IS NULL
       ORDER BY d.updated_at DESC`,
      [workspaceId, userId],
    );
    return result.rows.map(toDocumentRecord);
  }

  async getDocument(documentId: string, userId: string): Promise<DocumentRecord | null> {
    const result = await this.pool.query<DocumentRow>(
      `SELECT d.id, d.workspace_id, d.title, d.created_at, d.updated_at, m.role
       FROM app.documents d
       JOIN app.workspace_memberships m
         ON m.workspace_id = d.workspace_id AND m.user_id = $2
       WHERE d.id = $1 AND d.archived_at IS NULL`,
      [documentId, userId],
    );
    const row = result.rows[0];
    return row ? toDocumentRecord(row) : null;
  }

  async createDocument(input: {
    workspaceId: string;
    userId: string;
    title: string;
    documentId?: string;
  }): Promise<DocumentRecord> {
    const workspace = await this.getWorkspace(input.workspaceId, input.userId);
    if (!workspace) throw new NotFoundError("Workspace not found");

    // Keep the role check in the same statement as the insert so a concurrent
    // downgrade cannot slip a document creation between the check and write.
    const result = await this.pool.query<DocumentRow>(
      `WITH membership AS (
         SELECT role
         FROM app.workspace_memberships
         WHERE workspace_id = $1 AND user_id = $3 AND role IN ('owner', 'editor')
       ),
       inserted AS (
         INSERT INTO app.documents (id, workspace_id, title, created_by)
         SELECT COALESCE($4::uuid, gen_random_uuid()), $1, $2, $3
         FROM membership
         RETURNING id, workspace_id, title, created_at, updated_at
       )
       SELECT i.id, i.workspace_id, i.title, i.created_at, i.updated_at, m.role
       FROM inserted i
       CROSS JOIN membership m`,
      [input.workspaceId, input.title, input.userId, input.documentId ?? null],
    );
    const row = result.rows[0];
    if (!row) throw new ForbiddenError("Viewers cannot create documents");
    return toDocumentRecord(row);
  }

  async renameDocument(input: {
    documentId: string;
    userId: string;
    title: string;
  }): Promise<DocumentRecord> {
    const result = await this.pool.query<DocumentRow>(
      `UPDATE app.documents d
       SET title = $3
       FROM app.workspace_memberships m
       WHERE d.id = $1
         AND m.workspace_id = d.workspace_id
         AND m.user_id = $2
         AND m.role IN ('owner', 'editor')
         AND d.archived_at IS NULL
       RETURNING d.id, d.workspace_id, d.title, d.created_at, d.updated_at, m.role`,
      [input.documentId, input.userId, input.title],
    );
    const row = result.rows[0];
    if (!row) {
      const document = await this.getDocument(input.documentId, input.userId);
      if (!document) throw new NotFoundError("Document not found");
      throw new ForbiddenError("Viewers cannot rename documents");
    }
    return toDocumentRecord(row);
  }

  async deleteDocument(input: { documentId: string; userId: string }): Promise<void> {
    const result = await this.pool.query<{ id: string }>(
      `DELETE FROM app.documents d
       USING app.workspace_memberships m
       WHERE d.id = $1
         AND m.workspace_id = d.workspace_id
         AND m.user_id = $2
         AND m.role = 'owner'
       RETURNING d.id`,
      [input.documentId, input.userId],
    );
    if (result.rowCount === 0) {
      const document = await this.getDocument(input.documentId, input.userId);
      if (!document) throw new NotFoundError("Document not found");
      throw new ForbiddenError("Only workspace owners can delete documents");
    }
  }

  async createInvitation(input: {
    workspaceId: string;
    invitedBy: string;
    email: string;
    role: Exclude<MembershipRole, "owner">;
    tokenHash: string;
    expiresAt: Date;
  }): Promise<InvitationRecord> {
    try {
      const result = await this.pool.query<InvitationRow>(
        `INSERT INTO app.invitations
           (workspace_id, email, role, token_hash, invited_by, expires_at)
         SELECT $1, $2, $3, $4, $5, $6
         WHERE EXISTS (
           SELECT 1 FROM app.workspace_memberships
           WHERE workspace_id = $1 AND user_id = $5 AND role = 'owner'
         )
         RETURNING id, workspace_id, email, role, expires_at, accepted_at, revoked_at, created_at`,
        [
          input.workspaceId,
          input.email,
          input.role,
          input.tokenHash,
          input.invitedBy,
          input.expiresAt,
        ],
      );
      const row = result.rows[0];
      if (!row) throw new ForbiddenError("Only workspace owners can invite collaborators");
      return toInvitationRecord(row);
    } catch (error) {
      if (isPgUniqueViolation(error)) {
        throw new ConflictError("Invitation token collision; retry the request");
      }
      throw error;
    }
  }

  async acceptInvitation(input: {
    tokenHash: string;
    userId: string;
  }): Promise<WorkspaceRecord> {
    return withTransaction(this.pool, async (client) => {
      const invitationResult = await client.query<
        InvitationRow & { user_email: string | null }
      >(
        `SELECT i.id, i.workspace_id, i.email, i.role, i.expires_at, i.accepted_at,
                i.revoked_at, i.created_at, u.email::text AS user_email
         FROM app.invitations i
         JOIN app.users u ON u.id = $2
         WHERE i.token_hash = $1
         FOR UPDATE OF i`,
        [input.tokenHash, input.userId],
      );
      const invitation = invitationResult.rows[0];
      if (!invitation) throw new InvalidTokenError();
      if (invitation.revoked_at) throw new InvalidTokenError("Invitation was revoked");
      if (invitation.accepted_at) throw new InvalidTokenError("Invitation was already accepted");
      if (invitation.expires_at.getTime() <= Date.now()) {
        throw new InvalidTokenError("Invitation has expired");
      }
      if (invitation.user_email?.toLowerCase() !== invitation.email.toLowerCase()) {
        throw new ForbiddenError("Sign in with the email address that was invited");
      }

      await client.query(
        `INSERT INTO app.workspace_memberships (workspace_id, user_id, role)
         VALUES ($1, $2, $3)
         ON CONFLICT (workspace_id, user_id) DO NOTHING`,
        [invitation.workspace_id, input.userId, invitation.role],
      );

      await client.query(
        `UPDATE app.invitations SET accepted_at = now() WHERE id = $1 AND accepted_at IS NULL`,
        [invitation.id],
      );

      const workspaceResult = await client.query<WorkspaceRow>(
        `SELECT w.id, w.name, w.slug, w.created_at, m.role
         FROM app.workspaces w
         JOIN app.workspace_memberships m ON m.workspace_id = w.id
         WHERE w.id = $1 AND m.user_id = $2`,
        [invitation.workspace_id, input.userId],
      );
      const workspace = workspaceResult.rows[0];
      if (!workspace) throw new NotFoundError("Workspace no longer exists");
      return toWorkspaceRecord(workspace);
    });
  }

  private async requireWorkspaceRole(
    workspaceId: string,
    userId: string,
    minimum: MembershipRole,
  ): Promise<MembershipRole> {
    const workspace = await this.getWorkspace(workspaceId, userId);
    if (!workspace) throw new NotFoundError("Workspace not found");
    if (minimum === "viewer") return workspace.role;
    if (workspace.role === "owner") return workspace.role;
    if (minimum === "editor" && workspace.role === "editor") return workspace.role;
    throw new ForbiddenError();
  }
}
