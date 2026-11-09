import { randomUUID } from "node:crypto";

import { SignJWT, jwtVerify, errors as joseErrors } from "jose";
import { z } from "zod";

const claimsSchema = z.object({
  sub: z.string().uuid(),
  email: z.string().email(),
  name: z.string().min(1),
  typ: z.literal("access"),
  iss: z.string(),
  aud: z.union([z.string(), z.array(z.string())]),
  exp: z.number().int(),
  iat: z.number().int(),
  jti: z.string(),
});

export interface AccessTokenClaims {
  sub: string;
  email: string;
  name: string;
  typ: "access";
  jti: string;
  expiresAt: number;
}

export interface TokenServiceOptions {
  secret: string;
  issuer: string;
  audience: string;
  ttlSeconds: number;
}

export class TokenError extends Error {
  readonly reason: "invalid" | "expired";

  constructor(reason: "invalid" | "expired", message = "Invalid access token") {
    super(message);
    this.name = "TokenError";
    this.reason = reason;
  }
}

/**
 * HS256 is sufficient here because API and realtime are one trust domain and
 * only exchange short-lived access tokens signed with the same deployment
 * secret. Tokens are never accepted by the browser as a source of truth for
 * roles; the database is rechecked on every socket upgrade and write.
 */
export class TokenService {
  private readonly key: Uint8Array;
  private readonly issuer: string;
  private readonly audience: string;
  private readonly ttlSeconds: number;

  constructor(options: TokenServiceOptions) {
    if (options.secret.length < 32) {
      throw new Error("JWT_SECRET must be at least 32 characters");
    }
    if (!Number.isInteger(options.ttlSeconds) || options.ttlSeconds < 60) {
      throw new Error("ACCESS_TOKEN_TTL_SECONDS must be an integer of at least 60");
    }
    this.key = new TextEncoder().encode(options.secret);
    this.issuer = options.issuer;
    this.audience = options.audience;
    this.ttlSeconds = options.ttlSeconds;
  }

  async issue(input: { userId: string; email: string; displayName: string }): Promise<{
    token: string;
    expiresIn: number;
  }> {
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({
      email: input.email,
      name: input.displayName,
      typ: "access",
    })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setSubject(input.userId)
      .setIssuer(this.issuer)
      .setAudience(this.audience)
      .setJti(randomUUID())
      .setIssuedAt(now)
      .setExpirationTime(now + this.ttlSeconds)
      .sign(this.key);

    return { token, expiresIn: this.ttlSeconds };
  }

  async verify(token: string): Promise<AccessTokenClaims> {
    try {
      const { payload } = await jwtVerify(token, this.key, {
        algorithms: ["HS256"],
        issuer: this.issuer,
        audience: this.audience,
        clockTolerance: 5,
      });
      const parsed = claimsSchema.safeParse(payload);
      if (!parsed.success) throw new TokenError("invalid", "Malformed access token claims");
      return {
        sub: parsed.data.sub,
        email: parsed.data.email,
        name: parsed.data.name,
        typ: parsed.data.typ,
        jti: parsed.data.jti,
        expiresAt: parsed.data.exp,
      };
    } catch (error) {
      if (error instanceof TokenError) throw error;
      if (error instanceof joseErrors.JWTExpired) {
        throw new TokenError("expired", "Access token expired");
      }
      throw new TokenError("invalid");
    }
  }
}
