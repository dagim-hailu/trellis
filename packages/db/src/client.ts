import { Pool, type PoolClient, type PoolConfig } from "pg";

import { NotFoundError } from "./errors.js";

export type DatabasePool = Pool;

export interface DatabaseOptions {
  connectionString: string;
  maxConnections?: number;
  idleTimeoutMs?: number;
  connectionTimeoutMs?: number;
}

export function createDatabasePool(options: DatabaseOptions): Pool {
  const config: PoolConfig = {
    connectionString: options.connectionString,
    max: options.maxConnections ?? 20,
    idleTimeoutMillis: options.idleTimeoutMs ?? 30_000,
    connectionTimeoutMillis: options.connectionTimeoutMs ?? 5_000,
    application_name: "trellis",
  };

  const pool = new Pool(config);
  // pg emits idle-client errors on the pool. Applications must attach a
  // listener so a broken idle connection never becomes an unhandled error.
  pool.on("error", () => undefined);
  return pool;
}

export async function withTransaction<T>(
  pool: Pool,
  callback: (client: PoolClient) => Promise<T>,
  isolation: "READ COMMITTED" | "REPEATABLE READ" = "READ COMMITTED",
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query(`BEGIN ISOLATION LEVEL ${isolation}`);
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Preserve the original failure; the connection is discarded by pg if it
      // is no longer usable.
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function acquireDocumentLock(client: PoolClient, documentId: string): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))", [documentId]);
}

export async function assertDocumentExists(client: PoolClient, documentId: string): Promise<void> {
  const result = await client.query<{ exists: boolean }>(
    "SELECT EXISTS (SELECT 1 FROM app.documents WHERE id = $1 AND archived_at IS NULL) AS exists",
    [documentId],
  );
  if (!result.rows[0]?.exists) {
    throw new NotFoundError("Document not found");
  }
}

export async function pingDatabase(pool: Pool): Promise<void> {
  await pool.query("SELECT 1");
}

export async function closePool(pool: Pool): Promise<void> {
  await pool.end();
}
