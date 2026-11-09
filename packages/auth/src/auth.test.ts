import { describe, expect, it } from "vitest";

import { hashPassword, verifyPassword } from "./password.js";
import { TokenError, TokenService } from "./tokens.js";

const USER_ID = "c94babf0-87de-4af2-86f0-55ca522c1840";

describe("password hashing", () => {
  it("round-trips a password and rejects a wrong password", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(hash.startsWith("scrypt$")).toBe(true);
    await expect(verifyPassword("correct horse battery staple", hash)).resolves.toBe(true);
    await expect(verifyPassword("wrong horse battery staple", hash)).resolves.toBe(false);
  });

  it("rejects tampered or malformed hashes", async () => {
    await expect(verifyPassword("anything", "scrypt$bad")).resolves.toBe(false);
    await expect(verifyPassword("anything", "plaintext")).resolves.toBe(false);
  });
});

describe("access tokens", () => {
  const service = new TokenService({
    secret: "a-test-secret-that-is-longer-than-thirty-two-characters",
    issuer: "test-issuer",
    audience: "test-audience",
    ttlSeconds: 3600,
  });

  it("issues verifiable claims", async () => {
    const issued = await service.issue({
      userId: USER_ID,
      email: "ada@example.com",
      displayName: "Ada",
    });
    const claims = await service.verify(issued.token);
    expect(claims.sub).toBe(USER_ID);
    expect(claims.email).toBe("ada@example.com");
    expect(claims.typ).toBe("access");
    expect(issued.expiresIn).toBe(3600);
  });

  it("rejects tokens signed by another secret", async () => {
    const other = new TokenService({
      secret: "another-test-secret-that-is-longer-than-thirty-two-chars",
      issuer: "test-issuer",
      audience: "test-audience",
      ttlSeconds: 3600,
    });
    const issued = await other.issue({
      userId: USER_ID,
      email: "ada@example.com",
      displayName: "Ada",
    });
    await expect(service.verify(issued.token)).rejects.toBeInstanceOf(TokenError);
  });
});
