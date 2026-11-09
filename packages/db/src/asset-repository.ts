import type { Pool } from "pg";

import { ConflictError, ForbiddenError, NotFoundError } from "./errors.js";
import { toAssetRecord, type AssetRecord, type AssetRow } from "./rows.js";

/**
 * Asset metadata access. Every read is scoped by workspace membership so a
 * caller can never see another tenant's assets by guessing an id.
 */
export class AssetRepository {
  constructor(private readonly pool: Pool) {}

  /** Effective role for a user in a workspace, or null when not a member. */
  async getWorkspaceRole(workspaceId: string, userId: string): Promise<string | null> {
    const result = await this.pool.query<{ role: string }>(
      `SELECT m.role
       FROM app.workspace_memberships m
       WHERE m.workspace_id = $1 AND m.user_id = $2`,
      [workspaceId, userId],
    );
    return result.rows[0]?.role ?? null;
  }

  async insertAsset(input: {
    id: string;
    workspaceId: string;
    createdBy: string;
    mimeType: string;
    byteSize: number;
    storageKey: string;
    publicUrl: string;
    width: number | null;
    height: number | null;
  }): Promise<AssetRecord> {
    try {
      const result = await this.pool.query<AssetRow>(
        `INSERT INTO app.assets
           (id, workspace_id, created_by, mime_type, byte_size, storage_key, public_url, width, height)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING id, workspace_id, created_by, mime_type, byte_size,
                   storage_key, public_url, width, height, created_at`,
        [
          input.id,
          input.workspaceId,
          input.createdBy,
          input.mimeType,
          input.byteSize,
          input.storageKey,
          input.publicUrl,
          input.width,
          input.height,
        ],
      );
      const row = result.rows[0];
      if (!row) throw new Error("Asset insert returned no row");
      return toAssetRecord(row);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictError("Asset already confirmed");
      }
      throw error;
    }
  }

  async listAssets(
    workspaceId: string,
    userId: string,
    options: { limit: number; before: string | null },
  ): Promise<AssetRecord[]> {
    const result = await this.pool.query<AssetRow>(
      `SELECT a.id, a.workspace_id, a.created_by, a.mime_type, a.byte_size,
              a.storage_key, a.public_url, a.width, a.height, a.created_at
       FROM app.assets a
       JOIN app.workspace_memberships m ON m.workspace_id = a.workspace_id
       WHERE a.workspace_id = $1
         AND m.user_id = $2
         AND ($3::timestamptz IS NULL OR a.created_at < $3::timestamptz)
       ORDER BY a.created_at DESC
       LIMIT $4`,
      [workspaceId, userId, options.before, options.limit],
    );
    return result.rows.map(toAssetRecord);
  }

  /**
   * Fetch an asset the user is allowed to read. Membership is joined in the
   * query rather than checked afterwards, so an unauthorized id is
   * indistinguishable from a missing one.
   */
  async getAssetForUser(assetId: string, userId: string): Promise<AssetRecord | null> {
    const result = await this.pool.query<AssetRow>(
      `SELECT a.id, a.workspace_id, a.created_by, a.mime_type, a.byte_size,
              a.storage_key, a.public_url, a.width, a.height, a.created_at
       FROM app.assets a
       JOIN app.workspace_memberships m ON m.workspace_id = a.workspace_id
       WHERE a.id = $1 AND m.user_id = $2`,
      [assetId, userId],
    );
    const row = result.rows[0];
    return row ? toAssetRecord(row) : null;
  }

  async requireAssetForUser(assetId: string, userId: string): Promise<AssetRecord> {
    const asset = await this.getAssetForUser(assetId, userId);
    if (!asset) throw new NotFoundError("Asset not found or inaccessible");
    return asset;
  }

  async deleteAsset(assetId: string, userId: string): Promise<void> {
    const result = await this.pool.query(
      `DELETE FROM app.assets a
       USING app.workspace_memberships m
       WHERE a.id = $1
         AND m.workspace_id = a.workspace_id
         AND m.user_id = $2
         AND m.role IN ('owner', 'editor')`,
      [assetId, userId],
    );
    if (result.rowCount === 0) {
      throw new ForbiddenError("Asset not found or insufficient role");
    }
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "23505"
  );
}
