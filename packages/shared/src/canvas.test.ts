import { describe, expect, it } from "vitest";

import {
  NODE_TYPES,
  createCanvasNode,
  distanceToPolyline,
  nodeBounds,
  normalizeRotation,
  pointHitsNode,
  portPoint,
  worldToLocal,
  type CanvasNode,
} from "@trellis/shared";

function node(overrides: Partial<CanvasNode> = {}): CanvasNode {
  return createCanvasNode({
    id: "n1",
    type: "rect",
    x: 100,
    y: 100,
    width: 200,
    height: 100,
    createdBy: "u1",
    ...overrides,
  });
}

describe("node contract", () => {
  it("exposes all eight node types", () => {
    expect([...NODE_TYPES]).toEqual([
      "rect",
      "ellipse",
      "text",
      "note",
      "path",
      "image",
      "connector",
      "frame",
    ]);
  });

  it("omits optional fields instead of writing undefined", () => {
    const created = node();
    // exactOptionalPropertyTypes discipline: absent means the key is not there.
    expect("rotation" in created).toBe(false);
    expect("opacity" in created).toBe(false);
    expect("parentFrameId" in created).toBe(false);
  });

  it("writes optional fields when they carry a value", () => {
    const created = node({ rotation: 1, opacity: 0.5, locked: true, parentFrameId: "f1" });
    expect(created.rotation).toBe(1);
    expect(created.opacity).toBe(0.5);
    expect(created.locked).toBe(true);
    expect(created.parentFrameId).toBe("f1");
  });

  it("normalises rotation into [0, 2pi)", () => {
    expect(normalizeRotation(0)).toBe(0);
    expect(normalizeRotation(Math.PI * 2)).toBeCloseTo(0, 6);
    expect(normalizeRotation(-Math.PI / 2)).toBeCloseTo((Math.PI * 3) / 2, 6);
    expect(normalizeRotation(Number.NaN)).toBe(0);
  });
});

describe("rotation-aware geometry", () => {
  it("returns the unrotated box when rotation is zero", () => {
    const bounds = nodeBounds(node());
    expect(bounds).toEqual({ left: 100, top: 100, right: 300, bottom: 200 });
  });

  it("grows the AABB for a rotated box", () => {
    const square = node({ x: 0, y: 0, width: 100, height: 100, rotation: Math.PI / 4 });
    const bounds = nodeBounds(square);
    // A 100x100 square rotated 45 degrees has an AABB of about 141x141.
    expect(bounds.right - bounds.left).toBeCloseTo(141.42, 1);
    expect(bounds.bottom - bounds.top).toBeCloseTo(141.42, 1);
  });

  it("maps a world point into local space by the inverse rotation", () => {
    const rotated = node({ x: 0, y: 0, width: 100, height: 100, rotation: Math.PI / 2 });
    // The centre is invariant under rotation about the centre.
    const centre = worldToLocal({ x: 50, y: 50 }, rotated);
    expect(centre.x).toBeCloseTo(50, 6);
    expect(centre.y).toBeCloseTo(50, 6);
  });

  it("hit tests a rotated rectangle in local space", () => {
    // A tall thin box rotated 90 degrees becomes wide and short: it spans
    // x from -90 to 110 and y from 90 to 110, centred on (10, 100).
    const rotated = node({ x: 0, y: 0, width: 20, height: 200, rotation: Math.PI / 2 });
    // Inside the rotated box but outside the original 20-wide box.
    expect(pointHitsNode(rotated, { x: 100, y: 100 })).toBe(true);
    // Beyond the rotated extent on the x axis.
    expect(pointHitsNode(rotated, { x: 140, y: 100 })).toBe(false);
    // Far above the rotated box.
    expect(pointHitsNode(rotated, { x: 10, y: -60 })).toBe(false);
  });

  it("still hit tests ellipses as ellipses, not boxes", () => {
    const ellipse = node({ type: "ellipse", x: 0, y: 0, width: 100, height: 100 });
    expect(pointHitsNode(ellipse, { x: 50, y: 50 })).toBe(true);
    // The corner of the bounding box is outside the ellipse.
    expect(pointHitsNode(ellipse, { x: 2, y: 2 })).toBe(false);
  });
});

describe("path geometry", () => {
  it("measures distance to a polyline", () => {
    const points = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
    ];
    expect(distanceToPolyline({ x: 50, y: 10 }, points)).toBeCloseTo(10, 6);
    expect(distanceToPolyline({ x: 50, y: 0 }, points)).toBeCloseTo(0, 6);
  });

  it("hit tests a path against its stroke, not its bounding box", () => {
    const path = node({
      type: "path",
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      strokeWidth: 2,
      points: [
        { x: 0, y: 0 },
        { x: 100, y: 100 },
      ],
    });
    // On the diagonal: a hit.
    expect(pointHitsNode(path, { x: 50, y: 50 })).toBe(true);
    // Inside the bounding box but far from the diagonal: a miss.
    expect(pointHitsNode(path, { x: 90, y: 10 })).toBe(false);
  });
});

describe("connector ports", () => {
  it("resolves each port to the correct border anchor", () => {
    const box = node({ x: 0, y: 0, width: 100, height: 50 });
    expect(portPoint(box, "n")).toEqual({ x: 50, y: 0 });
    expect(portPoint(box, "s")).toEqual({ x: 50, y: 50 });
    expect(portPoint(box, "e")).toEqual({ x: 100, y: 25 });
    expect(portPoint(box, "w")).toEqual({ x: 0, y: 25 });
  });

  it("rotates the port anchor with the node", () => {
    const box = node({ x: 0, y: 0, width: 100, height: 50, rotation: Math.PI / 2 });
    const east = portPoint(box, "e");
    // Rotating 90 degrees moves the east anchor to the bottom.
    expect(east.x).toBeCloseTo(50, 6);
    expect(east.y).toBeCloseTo(75, 6);
  });
});
