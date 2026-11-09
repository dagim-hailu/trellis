import type { FastifyRequest } from "fastify";
import type { TokenService, AccessTokenClaims } from "@trellis/auth";
import type { ZodType, ZodTypeDef } from "zod";

import { UnauthorizedError, ValidationError } from "./errors.js";

const AUTH_SCHEME = /^Bearer ([A-Za-z0-9\-._~+/]+=*)$/i;

export async function requireAuth(
  request: FastifyRequest,
  tokens: TokenService,
): Promise<AccessTokenClaims> {
  const header = request.headers.authorization;
  if (!header) throw new UnauthorizedError();

  const match = AUTH_SCHEME.exec(header);
  const token = match?.[1];
  if (!token) throw new UnauthorizedError("Authorization header must use the Bearer scheme");

  try {
    return await tokens.verify(token);
  } catch {
    throw new UnauthorizedError("Access token is invalid or expired");
  }
}

export function parseBody<T>(
  schema: ZodType<T, ZodTypeDef, unknown>,
  body: unknown,
): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    const firstIssue = result.error.issues[0];
    const path = firstIssue?.path.join(".");
    const message = firstIssue ? (path ? `${path}: ${firstIssue.message}` : firstIssue.message) : undefined;
    throw new ValidationError(message ?? "Invalid request body");
  }
  return result.data;
}

export function parseUuid(value: string, field = "id"): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new ValidationError(`${field} must be a UUID`);
  }
  return value;
}
