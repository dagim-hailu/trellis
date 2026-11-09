import * as Y from "yjs";
import { describe, expect, it } from "vitest";

import { DEFAULT_LAYER_ID } from "@trellis/shared";

import {
  addLayer,
  applyFrameAutoLayout,
  createComponent,
  createNode,
  deleteLayerWithFallback,
  ensureDefaultLayer,
  getCanvasMaps,
  insertNodeCopies,
  moveLayer,
  moveNodesToLayer,
  readLayers,
  readComponents,
  readNodeById,
  reorderNodes,
  updateNode,
} from "./model";

function setup() {
  const doc = new Y.Doc();
  const maps = getCanvasMaps(doc);
  ensureDefaultLayer(doc, maps);
  return { doc, maps };
}

describe("canvas CRDT mutations", () => {
  it("adds, reorders, renames, and deletes layers with node fallback", () => {
    const { doc, maps } = setup();
    const second = addLayer(doc, maps, "Second");
    expect(readLayers(maps)).toHaveLength(2);

    moveLayer(doc, maps, second.id, "down");
    expect(readLayers(maps)[0]?.id).toBe(second.id);
    moveLayer(doc, maps, second.id, "up");
    expect(readLayers(maps)[1]?.id).toBe(second.id);

    const node = createNode(doc, maps, {
      id: crypto.randomUUID(),
      type: "rect",
      x: 0,
      y: 0,
      width: 100,
      height: 60,
      createdBy: "user",
      layerId: DEFAULT_LAYER_ID,
    });

    expect(deleteLayerWithFallback(doc, maps, DEFAULT_LAYER_ID, second.id)).toBe(true);
    expect(readLayers(maps)).toHaveLength(1);
    expect(readNodeById(maps, node.id)?.layerId).toBe(second.id);
    doc.destroy();
  });

  it("copies node snapshots with new ids and increments z-order", () => {
    const { doc, maps } = setup();
    const source = createNode(doc, maps, {
      id: crypto.randomUUID(),
      type: "note",
      x: 30,
      y: 40,
      width: 220,
      height: 160,
      createdBy: "user",
      layerId: DEFAULT_LAYER_ID,
    });
    const copies = insertNodeCopies(doc, maps, [source], {
      createdBy: "user",
      fallbackLayerId: DEFAULT_LAYER_ID,
      offsetX: 24,
      offsetY: 24,
    });
    expect(copies).toHaveLength(1);
    expect(copies[0]?.id).not.toBe(source.id);
    expect(copies[0]?.x).toBe(54);
    expect(copies[0]?.zIndex).toBeGreaterThan(source.zIndex);
    doc.destroy();
  });

  it("keeps copied connectors attached to copied endpoints", () => {
    const { doc, maps } = setup();
    const start = createNode(doc, maps, {
      id: "start",
      type: "rect",
      x: 0,
      y: 0,
      width: 80,
      height: 40,
      createdBy: "user",
      layerId: DEFAULT_LAYER_ID,
    });
    const end = createNode(doc, maps, {
      id: "end",
      type: "rect",
      x: 160,
      y: 0,
      width: 80,
      height: 40,
      createdBy: "user",
      layerId: DEFAULT_LAYER_ID,
    });
    const connector = createNode(doc, maps, {
      id: "connector",
      type: "connector",
      x: 0,
      y: 0,
      width: 160,
      height: 1,
      createdBy: "user",
      layerId: DEFAULT_LAYER_ID,
      startNodeId: start.id,
      endNodeId: end.id,
    });
    const copied = insertNodeCopies(doc, maps, [start, end, connector], {
      createdBy: "user",
      fallbackLayerId: DEFAULT_LAYER_ID,
      offsetX: 24,
      offsetY: 24,
    });
    const [copiedStart, copiedEnd, copiedConnector] = copied;
    expect(copiedConnector?.startNodeId).toBe(copiedStart?.id);
    expect(copiedConnector?.endNodeId).toBe(copiedEnd?.id);
    doc.destroy();
  });

  it("reparents copied frame children when the frame is copied with them", () => {
    const { doc, maps } = setup();
    const frame = createNode(doc, maps, {
      id: "frame-source",
      type: "frame",
      x: 0,
      y: 0,
      width: 300,
      height: 200,
      createdBy: "user",
      layerId: DEFAULT_LAYER_ID,
    });
    const child = createNode(doc, maps, {
      id: "frame-child",
      type: "rect",
      x: 20,
      y: 20,
      width: 80,
      height: 40,
      createdBy: "user",
      layerId: DEFAULT_LAYER_ID,
      parentFrameId: frame.id,
    });
    const [frameCopy, childCopy] = insertNodeCopies(doc, maps, [frame, child], {
      createdBy: "user",
      fallbackLayerId: DEFAULT_LAYER_ID,
      offsetX: 24,
      offsetY: 24,
    });
    expect(childCopy?.parentFrameId).toBe(frameCopy?.id);
    doc.destroy();
  });

  it("moves selected nodes to another layer and reorders them locally", () => {
    const { doc, maps } = setup();
    const second = addLayer(doc, maps, "Second");
    const node = createNode(doc, maps, {
      id: crypto.randomUUID(),
      type: "ellipse",
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      createdBy: "user",
      layerId: DEFAULT_LAYER_ID,
    });
    moveNodesToLayer(doc, maps, [node.id], second.id);
    expect(readNodeById(maps, node.id)?.layerId).toBe(second.id);
    reorderNodes(doc, maps, [node.id], "front");
    expect(readNodeById(maps, node.id)?.zIndex).toBeGreaterThanOrEqual(1);
    doc.destroy();
  });

  it("creates document-local components and propagates shared style edits", () => {
    const { doc, maps } = setup();
    const source = createNode(doc, maps, {
      id: crypto.randomUUID(),
      type: "rect",
      x: 10,
      y: 20,
      width: 120,
      height: 60,
      createdBy: "user",
      layerId: DEFAULT_LAYER_ID,
    });
    const component = createComponent(doc, maps, " Button ", [source.id]);
    expect(component?.name).toBe("Button");

    const linkedSource = readNodeById(maps, source.id)!;
    const [instance] = insertNodeCopies(doc, maps, [linkedSource], {
      createdBy: "user",
      fallbackLayerId: DEFAULT_LAYER_ID,
      offsetX: 200,
      offsetY: 100,
    });
    expect(instance?.componentId).toBe(component?.id);
    expect(readComponents(maps)).toEqual([
      { id: component?.id, name: "Button", nodeIds: [source.id] },
    ]);

    updateNode(doc, maps, source.id, { fill: "#123456", x: 40 });
    expect(readNodeById(maps, instance!.id)?.fill).toBe("#123456");
    expect(readNodeById(maps, instance!.id)?.x).toBe(instance!.x);
    expect(readNodeById(maps, source.id)?.x).toBe(40);
    doc.destroy();
  });

  it("applies deterministic vertical and horizontal frame layouts", () => {
    const { doc, maps } = setup();
    const frame = createNode(doc, maps, {
      id: crypto.randomUUID(),
      type: "frame",
      x: 100,
      y: 100,
      width: 400,
      height: 300,
      createdBy: "user",
      layerId: DEFAULT_LAYER_ID,
    });
    const first = createNode(doc, maps, {
      id: crypto.randomUUID(),
      type: "rect",
      x: 260,
      y: 240,
      width: 80,
      height: 40,
      createdBy: "user",
      layerId: DEFAULT_LAYER_ID,
      parentFrameId: frame.id,
    });
    const second = createNode(doc, maps, {
      id: crypto.randomUUID(),
      type: "note",
      x: 140,
      y: 140,
      width: 120,
      height: 60,
      createdBy: "user",
      layerId: DEFAULT_LAYER_ID,
      parentFrameId: frame.id,
    });

    expect(applyFrameAutoLayout(doc, maps, frame.id, "vertical", 12, 20, "start")).toEqual([
      second.id,
      first.id,
    ]);
    expect(readNodeById(maps, second.id)).toMatchObject({ x: 120, y: 120 });
    expect(readNodeById(maps, first.id)).toMatchObject({ x: 120, y: 192 });
    expect(readNodeById(maps, frame.id)).toMatchObject({
      layoutDirection: "vertical",
      layoutGap: 12,
      layoutPadding: 20,
      layoutAlignment: "start",
    });

    applyFrameAutoLayout(doc, maps, frame.id, "horizontal", 8, 10, "center");
    expect(readNodeById(maps, second.id)).toMatchObject({ x: 110, y: 220 });
    expect(readNodeById(maps, first.id)).toMatchObject({ x: 238, y: 230 });
    doc.destroy();
  });
});
