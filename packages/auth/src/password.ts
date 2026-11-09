import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";

function scrypt(
  password: string,
  salt: Buffer,
  keyLength: number,
  options: { N: number; r: number; p: number; maxmem: number },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, keyLength, options, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey);
    });
  });
}

// 2^15 is a practical server-side scrypt cost with a 64 MiB memory ceiling.
// Parameters are stored with each hash so they can be raised without breaking
// existing accounts.
const SCRYPT_N = 32_768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 64;
const MAX_MEMORY = 64 * 1024 * 1024;
const SALT_BYTES = 16;

export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 128;

export async function hashPassword(password: string): Promise<string> {
  assertPasswordLength(password);
  const salt = randomBytes(SALT_BYTES);
  const derived = (await scrypt(password, salt, KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: MAX_MEMORY,
  })) as Buffer;
  return [
    "scrypt",
    String(SCRYPT_N),
    String(SCRYPT_R),
    String(SCRYPT_P),
    salt.toString("base64url"),
    derived.toString("base64url"),
  ].join("$");
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  try {
    const [algorithm, nRaw, rRaw, pRaw, saltRaw, hashRaw] = encoded.split("$");
    if (
      algorithm !== "scrypt" ||
      !nRaw ||
      !rRaw ||
      !pRaw ||
      !saltRaw ||
      !hashRaw ||
      password.length > MAX_PASSWORD_LENGTH
    ) {
      return false;
    }

    const n = Number(nRaw);
    const r = Number(rRaw);
    const p = Number(pRaw);
    if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
    if (n < 16_384 || n > 1_048_576 || r < 1 || r > 32 || p < 1 || p > 16) return false;

    const salt = Buffer.from(saltRaw, "base64url");
    const expected = Buffer.from(hashRaw, "base64url");
    if (salt.length < 8 || expected.length < 32) return false;

    const maxmem = Math.min(256 * 1024 * 1024, Math.max(MAX_MEMORY, 128 * n * r + 1024));
    const derived = (await scrypt(password, salt, expected.length, { N: n, r, p, maxmem })) as Buffer;
    return derived.length === expected.length && timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

export function assertPasswordLength(password: string): void {
  if (password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
    throw new Error(
      `Password must be between ${MIN_PASSWORD_LENGTH} and ${MAX_PASSWORD_LENGTH} characters`,
    );
  }
}
