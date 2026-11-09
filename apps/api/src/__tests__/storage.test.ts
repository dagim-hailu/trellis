import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { encodeTemplateState, findTemplate, listTemplates } from "../lib/templates.js";
import {
  MemoryStorage,
  assertValidStorageKey,
  buildAssetStorageKey,
  InvalidStorageKeyError,
} from "../lib/storage.js";

describe("storage keys", () => {
  it("accepts a generated key", () => {
    const key = buildAssetStorageKey({
      workspaceId: "50b8c42e-ea1f-43d7-a81f-32fc1d82d8d0",
      assetId: "60b403ec-c56c-41fe-84ce-bca14b33e3bb",
      mimeType: "image/png",
    });
    expect(() => assertValidStorageKey(key)).not.toThrow();
    expect(key.endsWith(".png")).toBe(true);
  });

  it("derives the extension from the mime type, not the filename", () => {
    expect(
      buildAssetStorageKey({ workspaceId: "w", assetId: "a", mimeType: "image/jpeg" }).endsWith(".jpg"),
    ).toBe(true);
    expect(
      buildAssetStorageKey({ workspaceId: "w", assetId: "a", mimeType: "image/webp" }).endsWith(".webp"),
    ).toBe(true);
    expect(
      buildAssetStorageKey({ workspaceId: "w", assetId: "a", mimeType: "image/svg+xml" }).endsWith(".svg"),
    ).toBe(true);
  });

  it("rejects path traversal in a key", () => {
    expect(() => assertValidStorageKey("../etc/passwd")).toThrow(InvalidStorageKeyError);
    expect(() => assertValidStorageKey("a/../../b")).toThrow(InvalidStorageKeyError);
    expect(() => assertValidStorageKey("..")).toThrow(InvalidStorageKeyError);
  });

  it("rejects absolute paths and separators", () => {
    expect(() => assertValidStorageKey("/etc/passwd")).toThrow(InvalidStorageKeyError);
    expect(() => assertValidStorageKey("C:\\Windows\\system32")).toThrow(InvalidStorageKeyError);
    expect(() => assertValidStorageKey("nested/dir/file.png")).toThrow(InvalidStorageKeyError);
  });

  it("rejects empty and oversized keys", () => {
    expect(() => assertValidStorageKey("")).toThrow(InvalidStorageKeyError);
    expect(() => assertValidStorageKey("a".repeat(300))).toThrow(InvalidStorageKeyError);
  });
});

describe("memory storage adapter", () => {
  it("stores, reports size and reads back bytes", async () => {
    const storage = new MemoryStorage();
    const bytes = new Uint8Array([1, 2, 3, 4]);
    await storage.put("asset.png", bytes);

    expect(await storage.size("asset.png")).toBe(4);
    const stream = await storage.read("asset.png");
    expect(stream).not.toBeNull();
  });

  it("reports null size for a missing object", async () => {
    const storage = new MemoryStorage();
    expect(await storage.size("missing.png")).toBeNull();
    expect(await storage.read("missing.png")).toBeNull();
  });

  it("removes an object", async () => {
    const storage = new MemoryStorage();
    await storage.put("asset.png", new Uint8Array([1]));
    await storage.remove("asset.png");
    expect(await storage.size("asset.png")).toBeNull();
  });

  it("refuses to store under an invalid key", async () => {
    const storage = new MemoryStorage();
    await expect(storage.put("../escape.png", new Uint8Array([1]))).rejects.toThrow(
      InvalidStorageKeyError,
    );
  });
});

describe("template catalogue", () => {
  it("lists all five templates with node counts", () => {
    const templates = listTemplates();
    expect(templates).toHaveLength(5);
    expect(templates.map((template) => template.id)).toEqual([
      "mind-map",
      "kanban",
      "brainstorm-grid",
      "retro-board",
      "flowchart",
    ]);
    for (const template of templates) {
      expect(template.nodeCount).toBeGreaterThan(0);
      expect(template.name.length).toBeGreaterThan(0);
    }
  });

  it("returns null for an unknown template id", () => {
    expect(findTemplate("does-not-exist")).toBeNull();
  });

  it("encodes a real Yjs state with a state vector", () => {
    const seed = findTemplate("kanban");
    expect(seed).not.toBeNull();
    const encoded = encodeTemplateState(seed!);
    expect(encoded.state.byteLength).toBeGreaterThan(0);
    expect(encoded.stateVector.byteLength).toBeGreaterThan(0);
    expect(encoded.nodeCount).toBeGreaterThan(1);
  });

  it("encodes the same content for the same template", () => {
    const seed = findTemplate("flowchart")!;
    const first = encodeTemplateState(seed);
    const second = encodeTemplateState(seed);

    expect(first.nodeCount).toBe(second.nodeCount);

    // The state vector embeds a per-document random client id, so the encoded
    // bytes are never equal. Decode both and compare the actual content, which
    // is the property that matters: the same template yields the same document.
    const decode = (state: Uint8Array): string[] => {
      const doc = new Y.Doc();
      Y.applyUpdate(doc, state);
      const nodes = doc.getMap<Y.Map<unknown>>("nodes");
      const out: string[] = [];
      nodes.forEach((value, key) => {
        out.push(`${key}:${String(value.get("type"))}:${String(value.get("text"))}`);
      });
      return out.sort();
    };

    expect(decode(first.state)).toEqual(decode(second.state));
  });
});
