import type { Pool } from "pg";

import { ForbiddenError, NotFoundError } from "./errors.js";
import { toCommentRecord, type CommentRecord, type CommentRow } from "./rows.js";

const COMMENT_SELECT = `
  SELECT c.id, c.document_id, c.author_id, u.display_name AS author_name,
         c.parent_comment_id, c.x, c.y, c.content, c.resolved,
         c.created_at, c.updated_at
  FROM app.document_comments c
  JOIN app.users u ON u.id = c.author_id
`;

/**
 * Pinned canvas comments.
 *
 * Read access requires any workspace membership (viewer included). Write access
 * requires owner or editor, matching the access matrix in the README and the
 * database-level enforcement used for CRDT writes. Viewers can read a thread
 * but cannot post or resolve one.
 */
export class CommentRepository {
  constructor(private readonly pool: Pool) {}

  async listComments(documentId: string, userId: string): Promise<CommentRecord[]> {
    const result = await this.pool.query<CommentRow>(
      `${COMMENT_SELECT}
       JOIN app.documents d ON d.id = c.document_id
       JOIN app.workspace_memberships m ON m.workspace_id = d.workspace_id
       WHERE c.document_id = $1
         AND m.user_id = $2
         AND d.archived_at IS NULL
       ORDER BY c.created_at ASC`,
      [documentId, userId],
    );
    return result.rows.map(toCommentRecord);
  }

  async createComment(input: {
    documentId: string;
    authorId: string;
    x: number;
    y: number;
    content: string;
    parentCommentId: string | null;
  }): Promise<CommentRecord> {
    // The INSERT ... SELECT enforces editor access in the same statement that
    // writes the row: if the membership join yields nothing, no row is
    // inserted and rowCount is 0. There is no window between check and write.
    const result = await this.pool.query<{ id: string }>(
      `INSERT INTO app.document_comments
         (document_id, author_id, parent_comment_id, x, y, content)
       SELECT d.id, $2, $3, $4, $5, $6
       FROM app.documents d
       JOIN app.workspace_memberships m ON m.workspace_id = d.workspace_id
       WHERE d.id = $1
         AND m.user_id = $2
         AND m.role IN ('owner', 'editor')
         AND d.archived_at IS NULL
       RETURNING id`,
      [input.documentId, input.authorId, input.parentCommentId, input.x, input.y, input.content],
    );

    const inserted = result.rows[0];
    if (!inserted) {
      throw new ForbiddenError("Document not found or insufficient role");
    }

    const created = await this.getCommentById(inserted.id);
    if (!created) throw new NotFoundError("Comment not found after insert");
    return created;
  }

  async getCommentById(commentId: string): Promise<CommentRecord | null> {
    const result = await this.pool.query<CommentRow>(
      `${COMMENT_SELECT} WHERE c.id = $1`,
      [commentId],
    );
    const row = result.rows[0];
    return row ? toCommentRecord(row) : null;
  }

  async setResolved(input: {
    commentId: string;
    userId: string;
    resolved: boolean;
  }): Promise<CommentRecord> {
    const result = await this.pool.query<{ id: string }>(
      `UPDATE app.document_comments c
       SET resolved = $3
       FROM app.documents d, app.workspace_memberships m
       WHERE c.id = $1
         AND d.id = c.document_id
         AND m.workspace_id = d.workspace_id
         AND m.user_id = $2
         AND m.role IN ('owner', 'editor')
       RETURNING c.id`,
      [input.commentId, input.userId, input.resolved],
    );

    const updated = result.rows[0];
    if (!updated) {
      throw new ForbiddenError("Comment not found or insufficient role");
    }

    const record = await this.getCommentById(updated.id);
    if (!record) throw new NotFoundError("Comment not found after update");
    return record;
  }

  async deleteComment(commentId: string, userId: string): Promise<void> {
    const result = await this.pool.query(
      `DELETE FROM app.document_comments c
       USING app.documents d, app.workspace_memberships m
       WHERE c.id = $1
         AND d.id = c.document_id
         AND m.workspace_id = d.workspace_id
         AND m.user_id = $2
         AND m.role IN ('owner', 'editor')`,
      [commentId, userId],
    );
    if (result.rowCount === 0) {
      throw new ForbiddenError("Comment not found or insufficient role");
    }
  }
}
