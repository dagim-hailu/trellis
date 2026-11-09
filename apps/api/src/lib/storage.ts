import { createReadStream } from "node:fs";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import type { Readable } from "node:stream";

/**
 * Storage abstraction for uploaded assets.
 *
 * The API only ever talks to this interface, so moving from local disk to S3
 * or R2 means writing one more implementation and changing one env var. The
 * local implementation is the default because this repository has no cloud
 * credentials and docker-compose is local-only.
 */
export interface StorageAdapter {
  /** Write bytes for a storage key. Creates parent directories as needed. */
  put(key: string, bytes: Uint8Array): Promise<void>;
  /** Byte size of a stored object, or null when it does not exist. */
  size(key: string): Promise<number | null>;
  /** Readable stream of a stored object, or null when it does not exist. */
  read(key: string): Promise<Readable | null>;
  /** Remove an object. Missing objects are not an error. */
  remove(key: string): Promise<void>;
  /** URL the browser can fetch the object from. */
  publicUrl(key: string): string;
}

/**
 * Storage keys are generated server-side, never taken from a client. This
 * pattern is the second line of defence: even if a key were influenced by
 * input, it cannot express a path traversal, an absolute path, a drive letter
 * or a Windows alternate data stream.
 */
const STORAGE_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/;

export class InvalidStorageKeyError extends Error {
  constructor(key: string) {
    super(`Invalid storage key: ${key.slice(0, 64)}`);
    this.name = "InvalidStorageKeyError";
  }
}

export function assertValidStorageKey(key: string): void {
  if (!STORAGE_KEY_PATTERN.test(key) || key.includes("..")) {
    throw new InvalidStorageKeyError(key);
  }
}

export interface LocalDiskStorageOptions {
  /** Absolute directory that backs the store. */
  rootDir: string;
  /** Public base URL that maps to rootDir, e.g. http://localhost:4400/v1/assets. */
  publicBaseUrl: string;
}

/**
 * Filesystem-backed storage.
 *
 * Every path is resolved and then checked to be inside rootDir. `path.join`
 * alone is not sufficient: a key containing ".." segments would escape, and on
 * Windows a key beginning with a drive letter or a UNC prefix would be treated
 * as absolute. The containment check after `resolve` closes both.
 */
export class LocalDiskStorage implements StorageAdapter {
  private readonly rootDir: string;
  private readonly publicBaseUrl: string;

  constructor(options: LocalDiskStorageOptions) {
    this.rootDir = resolve(options.rootDir);
    this.publicBaseUrl = options.publicBaseUrl.replace(/\/$/, "");
  }

  private pathFor(key: string): string {
    assertValidStorageKey(key);
    const target = resolve(join(this.rootDir, key));
    const rootWithSep = this.rootDir.endsWith(sep) ? this.rootDir : `${this.rootDir}${sep}`;
    if (target !== this.rootDir && !target.startsWith(rootWithSep)) {
      throw new InvalidStorageKeyError(key);
    }
    return target;
  }

  async put(key: string, bytes: Uint8Array): Promise<void> {
    const target = this.pathFor(key);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
  }

  async size(key: string): Promise<number | null> {
    try {
      const info = await stat(this.pathFor(key));
      return info.isFile() ? info.size : null;
    } catch {
      return null;
    }
  }

  async read(key: string): Promise<Readable | null> {
    const target = this.pathFor(key);
    const size = await this.size(key);
    if (size === null) return null;
    return createReadStream(target);
  }

  async remove(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true });
  }

  publicUrl(key: string): string {
    assertValidStorageKey(key);
    return `${this.publicBaseUrl}/${encodeURIComponent(key)}/content`;
  }
}

/**
 * In-memory storage for tests. Same contract, no filesystem.
 */
export class MemoryStorage implements StorageAdapter {
  private readonly objects = new Map<string, Uint8Array>();

  async put(key: string, bytes: Uint8Array): Promise<void> {
    assertValidStorageKey(key);
    this.objects.set(key, bytes);
  }

  async size(key: string): Promise<number | null> {
    assertValidStorageKey(key);
    return this.objects.get(key)?.byteLength ?? null;
  }

  async read(key: string): Promise<Readable | null> {
    assertValidStorageKey(key);
    const bytes = this.objects.get(key);
    if (!bytes) return null;
    const { Readable: ReadableCtor } = await import("node:stream");
    return ReadableCtor.from(bytes);
  }

  async remove(key: string): Promise<void> {
    assertValidStorageKey(key);
    this.objects.delete(key);
  }

  publicUrl(key: string): string {
    assertValidStorageKey(key);
    return `/v1/assets/${encodeURIComponent(key)}/content`;
  }
}

/**
 * Build a storage key. Server-generated and opaque: the workspace scopes
 * collisions, the random suffix prevents guessing, and the extension is derived
 * from the validated mime type rather than from the client's filename.
 */
export function buildAssetStorageKey(input: {
  workspaceId: string;
  assetId: string;
  mimeType: string;
}): string {
  const extension =
    input.mimeType === "image/png"
      ? "png"
      : input.mimeType === "image/jpeg"
        ? "jpg"
        : input.mimeType === "image/webp"
          ? "webp"
          : "svg";
  return `ws-${input.workspaceId}-${input.assetId}.${extension}`;
}
