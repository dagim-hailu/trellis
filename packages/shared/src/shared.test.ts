import { describe, expect, it } from "vitest";

import {
  createCanvasNode,
  isNodeType,
  pointHitsNode,
  randomPresenceColor,
} from "./canvas.js";
import { documentAwarenessChannel, documentSyncChannel } from "./protocol.js";
import { canEdit, roleAtLeast } from "./roles.js";

describe("roles", () => {
  it("orders viewer below editor below owner", () => {
    expect(roleAtLeast("owner", "editor")).toBe(true);
    expect(roleAtLeast("editor", "viewer")).toBe(true);
    expect(roleAtLeast("viewer", "editor")).toBe(false);
    expect(canEdit("viewer")).toBe(false);
  });
});

describe("redis channel naming", () => {
  it("isolates documents and data classes", () => {
    const documentId = "20e6f3a4-17aa-4e84-9ae5-71d560d00100";
    expect(documentSyncChannel("trellis", documentId)).toBe(`trellis:document:${documentId}:sync`);
    expect(documentAwarenessChannel("trellis", documentId)).toBe(
      `trellis:document:${documentId}:awareness`,
    );
  });

  it("rejects separators that would make channels ambiguous", () => {
    expect(() => documentSyncChannel("bad:prefix", "20e6f3a4-17aa-4e84-9ae5-71d560d00100")).toThrow();
  });
});

describe("canvas hit testing", () => {
  it("excludes ellipse corners", () => {
    const ellipse = { type: "ellipse" as const, x: 0, y: 0, width: 100, height: 100 };
    expect(pointHitsNode(ellipse, { x: 50, y: 50 })).toBe(true);
    expect(pointHitsNode(ellipse, { x: 2, y: 2 })).toBe(false);
  });

  it("is deterministic for presence colors", () => {
    expect(randomPresenceColor("user-1")).toBe(randomPresenceColor("user-1"));
  });

  it("recognizes sticky notes as first-class canvas nodes", () => {
    expect(isNodeType("note")).toBe(true);
    const note = createCanvasNode({
      id: "note-1",
      type: "note",
      x: 10,
      y: 20,
      width: 220,
      height: 160,
      createdBy: "user-1",
    });
    expect(note.type).toBe("note");
    expect(note.fontSize).toBe(20);
    expect(pointHitsNode(note, { x: 30, y: 40 })).toBe(true);
  });
});
