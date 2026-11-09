import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { config as loadEnv } from "dotenv";
import type { PoolClient } from "pg";

import { createDatabasePool } from "./client.js";

loadEnv({
  path: [resolve(process.cwd(), ".env"), resolve(process.cwd(), "../../.env")],
  quiet: true,
});

const MIGRATION_LOCK_ID = "4815162342";

interface AppliedMigration {
  filename: string;
  checksum: string;
}

async function main(): Promise<void> {
  const databaseUrl = process.env["DATABASE_URL"];
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required to run migrations");
  }

  const migrationsDir = fileURLToPath(new URL("../migrations/", import.meta.url));
  const filenames = (await readdir(migrationsDir))
    .filter((filename) => filename.endsWith(".sql"))
    .sort((left, right) => left.localeCompare(right));

  if (filenames.length === 0) {
    throw new Error(`No migration files found in ${migrationsDir}`);
  }

  const pool = createDatabasePool({ connectionString: databaseUrl, maxConnections: 2 });
  let client: PoolClient | null = null;

  try {
    client = await pool.connect();
    await client.query("SELECT pg_advisory_lock($1::bigint)", [MIGRATION_LOCK_ID]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.schema_migrations (
        filename   text PRIMARY KEY,
        checksum   text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const appliedResult = await client.query<AppliedMigration>(
      "SELECT filename, checksum FROM public.schema_migrations",
    );
    const applied = new Map(appliedResult.rows.map((row) => [row.filename, row.checksum]));

    for (const filename of filenames) {
      const sql = await readFile(new URL(`../migrations/${filename}`, import.meta.url), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      const previouslyApplied = applied.get(filename);

      if (previouslyApplied) {
        if (previouslyApplied !== checksum) {
          throw new Error(
            `Checksum mismatch for already-applied migration ${filename}; create a new migration instead of editing history`,
          );
        }
        continue;
      }

      process.stdout.write(`Applying ${filename} ... `);
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query(
          "INSERT INTO public.schema_migrations (filename, checksum) VALUES ($1, $2)",
          [filename, checksum],
        );
        await client.query("COMMIT");
        process.stdout.write("ok\n");
      } catch (error) {
        await client.query("ROLLBACK");
        process.stdout.write("failed\n");
        throw error;
      }
    }

    process.stdout.write("All migrations applied.\n");
  } finally {
    if (client) {
      try {
        await client.query("SELECT pg_advisory_unlock($1::bigint)", [MIGRATION_LOCK_ID]);
      } finally {
        client.release();
      }
    }
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
