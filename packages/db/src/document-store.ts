import * as Y from "yjs";
import type { Pool } from "pg";

import { acquireDocumentLock, assertDocumentExists, withTransaction } from "./client.js";
import { ForbiddenError, NotFoundError } from "./errors.js";
import type { DocumentRecord, DocumentRow } from "./rows.js";
import { toDocumentRecord } from "./rows.js";

export interface DocumentUpdateBatchItem {
  id: string;
  update: Buffer;
}

export interface ColdStartState {
  documentId: string;
  snapshotVersion: string | null;
  snapshot: Buffer | null;
  throughUpdateId: string;
  updates: DocumentUpdateBatchItem[];
  latestUpdateId: string;
}

export interface CompactionResult {
  version: string;
  throughUpdateId: string;
  updatesRemoved: number;
  stateBytes: number;
}

export interface CompactionOptions {
  /** Number of snapshot versions to retain. Must be at least 1. */
  retention: number;
}

/**
 * The only writer of persistent Yjs data. All methods that mutate the update
 * log and snapshots take the same per-document transaction advisory lock, so
 * update appends and compaction can never interleave across Node processes.
 */
export class DocumentStore {
  constructor(private readonly pool: Pool) {}

  async getDocumentAccess(documentId: string, userId: string): Promise<DocumentRecord | null> {
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

  async loadForColdStart(documentId: string): Promise<ColdStartState> {
    return withTransaction(
      this.pool,
      async (client) => {
        await acquireDocumentLock(client, documentId);
        await assertDocumentExists(client, documentId);

        const snapshotResult = await client.query<{
          version: string;
          state: Buffer;
          through_update_id: string;
        }>(
          `SELECT version::text, state, through_update_id::text
           FROM app.document_snapshots
           WHERE document_id = $1
           ORDER BY version DESC
           LIMIT 1`,
          [documentId],
        );
        const snapshot = snapshotResult.rows[0] ?? null;
        const throughUpdateId = snapshot?.through_update_id ?? "0";

        const updatesResult = await client.query<{ id: string; update: Buffer }>(
          `SELECT id::text, update
           FROM app.document_updates
           WHERE document_id = $1 AND id > $2::bigint
           ORDER BY id ASC`,
          [documentId, throughUpdateId],
        );

        const updates = updatesResult.rows;
        return {
          documentId,
          snapshotVersion: snapshot?.version ?? null,
          snapshot: snapshot?.state ?? null,
          throughUpdateId,
          updates,
          latestUpdateId: updates.at(-1)?.id ?? throughUpdateId,
        };
      },
      // READ COMMITTED is required here, not REPEATABLE READ: the advisory lock
      // statement is the first query in the transaction and would freeze a
      // REPEATABLE READ snapshot *before* waiting for a writer holding the lock.
      // Once the lock is acquired no writer can interleave, so each subsequent
      // READ COMMITTED statement sees the complete committed log.
      "READ COMMITTED",
    );
  }

  async appendUpdate(input: {
    documentId: string;
    actorId: string;
    update: Uint8Array;
  }): Promise<{ updateId: string }> {
    return withTransaction(this.pool, async (client) => {
      await acquireDocumentLock(client, input.documentId);

      const result = await client.query<{ id: string }>(
        `INSERT INTO app.document_updates (document_id, actor_id, update)
         SELECT d.id, $2, $3
         FROM app.documents d
         JOIN app.workspace_memberships m
           ON m.workspace_id = d.workspace_id AND m.user_id = $2
         WHERE d.id = $1
           AND d.archived_at IS NULL
           AND m.role IN ('owner', 'editor')
         RETURNING id::text`,
        [input.documentId, input.actorId, Buffer.from(input.update)],
      );
      const row = result.rows[0];
      if (!row) {
        throw new ForbiddenError("The actor no longer has write access to this document");
      }

      await client.query("UPDATE app.documents SET updated_at = now() WHERE id = $1", [
        input.documentId,
      ]);
      return { updateId: row.id };
    });
  }

  /**
   * Builds a complete snapshot from the database under the document lock,
   * then atomically deletes only the updates included in that snapshot. Doing
   * this from Postgres, instead of from a room's in-memory replica, is what
   * makes pruning safe when a node missed a Redis message.
   */
  async compact(documentId: string, options: CompactionOptions): Promise<CompactionResult | null> {
    if (!Number.isInteger(options.retention) || options.retention < 1) {
      throw new Error("Compaction retention must be a positive integer");
    }

    return withTransaction(this.pool, async (client) => {
      await acquireDocumentLock(client, documentId);
      await assertDocumentExists(client, documentId);

      const snapshotResult = await client.query<{
        version: string;
        state: Buffer;
        through_update_id: string;
      }>(
        `SELECT version::text, state, through_update_id::text
         FROM app.document_snapshots
         WHERE document_id = $1
         ORDER BY version DESC
         LIMIT 1`,
        [documentId],
      );
      const base = snapshotResult.rows[0] ?? null;

      const updatesResult = await client.query<{ id: string; update: Buffer }>(
        `SELECT id::text, update
         FROM app.document_updates
         WHERE document_id = $1 AND id > $2::bigint
         ORDER BY id ASC`,
        [documentId, base?.through_update_id ?? "0"],
      );
      const updates = updatesResult.rows;
      if (updates.length === 0) return null;

      const throughUpdateId = updates.at(-1)?.id;
      if (!throughUpdateId) return null;

      const doc = new Y.Doc();
      let state: Uint8Array;
      let stateVector: Uint8Array;
      try {
        if (base) Y.applyUpdate(doc, base.state, "postgres-snapshot");
        for (const update of updates) {
          Y.applyUpdate(doc, update.update, "postgres-update");
        }
        state = Y.encodeStateAsUpdate(doc);
        stateVector = Y.encodeStateVector(doc);
      } finally {
        doc.destroy();
      }

      const nextVersion = base ? (BigInt(base.version) + 1n).toString() : "1";
      const snapshotResultInsert = await client.query<{ id: string }>(
        `INSERT INTO app.document_snapshots
           (document_id, version, state, state_vector, through_update_id)
         VALUES ($1, $2::bigint, $3, $4, $5::bigint)
         RETURNING id`,
        [documentId, nextVersion, Buffer.from(state), Buffer.from(stateVector), throughUpdateId],
      );
      if (!snapshotResultInsert.rows[0]) throw new Error("Snapshot insert returned no row");

      const deleted = await client.query(
        `DELETE FROM app.document_updates
         WHERE document_id = $1 AND id <= $2::bigint`,
        [documentId, throughUpdateId],
      );

      await client.query(
        `DELETE FROM app.document_snapshots
         WHERE document_id = $1
           AND id NOT IN (
             SELECT id FROM app.document_snapshots
             WHERE document_id = $1
             ORDER BY version DESC
             LIMIT $2
           )`,
        [documentId, options.retention],
      );

      return {
        version: nextVersion,
        throughUpdateId,
        updatesRemoved: deleted.rowCount ?? 0,
        stateBytes: state.byteLength,
      };
    });
  }

  async requireDocumentAccess(documentId: string, userId: string): Promise<DocumentRecord> {
    const document = await this.getDocumentAccess(documentId, userId);
    if (!document) throw new NotFoundError("Document not found or inaccessible");
    return document;
  }
}
