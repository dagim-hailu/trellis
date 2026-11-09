import type { Pool } from "pg";

import { ConflictError, isPgUniqueViolation } from "./errors.js";
import { toUserRecord, type UserRecord, type UserRow } from "./rows.js";

export class AuthRepository {
  constructor(private readonly pool: Pool) {}

  async createUser(input: {
    email: string;
    displayName: string;
    passwordHash: string;
  }): Promise<UserRecord> {
    try {
      const result = await this.pool.query<UserRow>(
        `INSERT INTO app.users (email, password_hash, display_name)
         VALUES ($1, $2, $3)
         RETURNING id, email, password_hash, display_name, created_at, updated_at`,
        [input.email, input.passwordHash, input.displayName],
      );
      const row = result.rows[0];
      if (!row) throw new Error("INSERT did not return a user");
      return toUserRecord(row);
    } catch (error) {
      if (isPgUniqueViolation(error)) {
        throw new ConflictError("An account with this email already exists");
      }
      throw error;
    }
  }

  async findByEmail(email: string): Promise<UserRecord | null> {
    const result = await this.pool.query<UserRow>(
      `SELECT id, email, password_hash, display_name, created_at, updated_at
       FROM app.users WHERE email = $1`,
      [email],
    );
    const row = result.rows[0];
    return row ? toUserRecord(row) : null;
  }

  async findById(id: string): Promise<UserRecord | null> {
    const result = await this.pool.query<UserRow>(
      `SELECT id, email, password_hash, display_name, created_at, updated_at
       FROM app.users WHERE id = $1`,
      [id],
    );
    const row = result.rows[0];
    return row ? toUserRecord(row) : null;
  }
}
