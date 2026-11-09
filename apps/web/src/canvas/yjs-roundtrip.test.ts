import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import {
  CANVAS_LAYERS,
  CANVAS_NODES,
  DEFAULT_LAYER_ID,
  createCanvasNode,
  type CanvasNode,
  type NodeType,
} from "@trellis/shared";

import { getCanvasMaps, createYNode, readNode, readNodes } from "./model";

/**
 * Round-trip every node type through a real Y.Doc.
 *
 * This is the test that catches the failure mode the whole optional-field
 * design exists to prevent: a field that is written to the Y.Map but not read
 * back, or one that is read back as a wrong type. A node that survives a
 * reload with its type-specific data intact is the contract.
 */
function roundTrip(node: CanvasNode): CanvasNode | null {
  const doc = new Y.Doc();
  const maps = getCanvasMaps(doc);
  maps.nodes.set(node.id, createYNode(node));

  // Encode and decode through the wire format, not just the in-memory map,
  // so this also covers the update encoding the realtime server uses.
  const update = Y.encodeStateAsUpdate(doc);
  const restored = new Y.Doc();
  Y.applyUpdate(restored, update);
  const restoredMaps = getCanvasMaps(restored);

  const value = restoredMaps.nodes.get(node.id);
  if (!(value instanceof Y.Map)) return null;
  return readNode(value, node.id);
}

const base = {
  id: "node-1",
  x: 10,
  y: 20,
  width: 100,
  height: 60,
  createdBy: "user-1",
};

describe("Yjs round-trip for all eight node types", () => {
  const types: NodeType[] = [
    "rect",
    "ellipse",
    "text",
    "note",
    "path",
    "image",
    "connector",
    "frame",
  ];

  for (const type of types) {
    it(`preserves a ${type} node`, () => {
      const node = createCanvasNode({ ...base, id: `node-${type}`, type });
      const restored = roundTrip(node);
      expect(restored).not.toBeNull();
      expect(restored!.type).toBe(type);
      expect(restored!.x).toBe(node.x);
      expect(restored!.y).toBe(node.y);
      expect(restored!.width).toBe(node.width);
      expect(restored!.height).toBe(node.height);
      expect(restored!.fill).toBe(node.fill);
    });
  }

  it("preserves path points and isClosed", () => {
    const node = createCanvasNode({
      ...base,
      id: "path-1",
      type: "path",
      points: [
        { x: 0, y: 0 },
        { x: 10, y: 20, pressure: 0.5 },
        { x: 30, y: 5 },
      ],
      isClosed: true,
    });
    const restored = roundTrip(node);
    expect(restored!.points).toHaveLength(3);
    expect(restored!.points![1]).toEqual({ x: 10, y: 20, pressure: 0.5 });
    expect(restored!.isClosed).toBe(true);
  });

  it("preserves image asset fields", () => {
    const node = createCanvasNode({
      ...base,
      id: "image-1",
      type: "image",
      assetId: "asset-abc",
      url: "https://example.test/a.png",
      aspectRatio: 1.777,
    });
    const restored = roundTrip(node);
    expect(restored!.assetId).toBe("asset-abc");
    expect(restored!.url).toBe("https://example.test/a.png");
    expect(restored!.aspectRatio).toBeCloseTo(1.777, 3);
  });

  it("preserves connector endpoints and style", () => {
    const node = createCanvasNode({
      ...base,
      id: "connector-1",
      type: "connector",
      startNodeId: "a",
      startPort: "e",
      endNodeId: "b",
      endPort: "w",
      curveType: "orthogonal",
      startHead: "circle",
      endHead: "arrow",
    });
    const restored = roundTrip(node);
    expect(restored!.startNodeId).toBe("a");
    expect(restored!.startPort).toBe("e");
    expect(restored!.endNodeId).toBe("b");
    expect(restored!.endPort).toBe("w");
    expect(restored!.curveType).toBe("orthogonal");
    expect(restored!.startHead).toBe("circle");
    expect(restored!.endHead).toBe("arrow");
  });

  it("preserves frame fields and parentFrameId", () => {
    const frame = createCanvasNode({
      ...base,
      id: "frame-1",
      type: "frame",
      aspectPreset: "16:9",
      clipContent: false,
    });
    const restoredFrame = roundTrip(frame);
    expect(restoredFrame!.aspectPreset).toBe("16:9");
    expect(restoredFrame!.clipContent).toBe(false);

    const child = createCanvasNode({
      ...base,
      id: "child-1",
      type: "rect",
      parentFrameId: "frame-1",
    });
    const restoredChild = roundTrip(child);
    expect(restoredChild!.parentFrameId).toBe("frame-1");
  });

  it("preserves universal rotation, opacity and locked", () => {
    const node = createCanvasNode({
      ...base,
      id: "rotated-1",
      type: "rect",
      rotation: 1.2,
      opacity: 0.4,
      locked: true,
    });
    const restored = roundTrip(node);
    expect(restored!.rotation).toBeCloseTo(1.2, 6);
    expect(restored!.opacity).toBeCloseTo(0.4, 6);
    expect(restored!.locked).toBe(true);
  });

  it("preserves component links and optional frame layout settings", () => {
    const node = createCanvasNode({
      ...base,
      id: "component-frame",
      type: "frame",
      componentId: "component-1",
      componentSourceNodeId: "source-1",
      layoutDirection: "horizontal",
      layoutGap: 12,
      layoutPadding: 20,
      layoutAlignment: "center",
    });
    const restored = roundTrip(node);
    expect(restored).toMatchObject({
      componentId: "component-1",
      componentSourceNodeId: "source-1",
      layoutDirection: "horizontal",
      layoutGap: 12,
      layoutPadding: 20,
      layoutAlignment: "center",
    });
  });

  it("does not resurrect absent optional fields as present keys", () => {
    const node = createCanvasNode({ ...base, id: "plain-1", type: "rect" });
    const restored = roundTrip(node);
    expect(restored).not.toBeNull();
    expect("rotation" in restored!).toBe(false);
    expect("points" in restored!).toBe(false);
    expect("parentFrameId" in restored!).toBe(false);
  });

  it("reads a whole document with layers intact", () => {
    const doc = new Y.Doc();
    const maps = getCanvasMaps(doc);
    const layer = new Y.Map<unknown>();
    layer.set("id", DEFAULT_LAYER_ID);
    layer.set("name", "Layer 1");
    layer.set("visible", true);
    layer.set("zIndex", 0);
    maps.layers.set(DEFAULT_LAYER_ID, layer);
    maps.nodes.set("n1", createYNode(createCanvasNode({ ...base, id: "n1", type: "note" })));
    maps.nodes.set("n2", createYNode(createCanvasNode({ ...base, id: "n2", type: "frame" })));

    const restored = new Y.Doc();
    Y.applyUpdate(restored, Y.encodeStateAsUpdate(doc));
    const restoredMaps = getCanvasMaps(restored);
    expect(restoredMaps.layers.has(DEFAULT_LAYER_ID)).toBe(true);
    expect(readNodes(restoredMaps)).toHaveLength(2);
    expect(CANVAS_NODES).toBe("nodes");
    expect(CANVAS_LAYERS).toBe("layers");
  });
});
