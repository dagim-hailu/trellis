import { describe, expect, it } from "vitest";

import { createCanvasNode, type CanvasNode } from "@trellis/shared";

import { computeSnap, snapThresholdForZoom } from "./snapping";
import { CanvasSpatialIndex, entryFor, viewportWorldRect } from "./spatial-index";

function node(overrides: Partial<CanvasNode> & { id: string }): CanvasNode {
  // Spread first, then the required defaults, so `id` is assigned exactly once
  // and any override still wins.
  return createCanvasNode({
    type: "rect",
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    createdBy: "u1",
    ...overrides,
  });
}

describe("snapping", () => {
  it("snaps a left edge to a neighbour's left edge", () => {
    const neighbour = node({ id: "a", x: 200, y: 0, width: 100, height: 100 });
    const result = computeSnap({
      moving: { x: 203, y: 300, width: 100, height: 100 },
      candidates: [neighbour],
      threshold: 6,
    });
    expect(result.x).toBe(200);
    expect(result.guides.some((guide) => guide.axis === "x")).toBe(true);
  });

  it("snaps centres together", () => {
    const neighbour = node({ id: "a", x: 0, y: 0, width: 200, height: 100 });
    // Moving box centre at 102 should snap to the neighbour centre at 100.
    const result = computeSnap({
      moving: { x: 52, y: 400, width: 100, height: 100 },
      candidates: [neighbour],
      threshold: 6,
    });
    expect(result.x).toBe(50);
  });

  it("does not snap beyond the threshold", () => {
    const neighbour = node({ id: "a", x: 200, y: 0, width: 100, height: 100 });
    const result = computeSnap({
      moving: { x: 240, y: 300, width: 100, height: 100 },
      candidates: [neighbour],
      threshold: 6,
    });
    expect(result.x).toBe(240);
    expect(result.guides).toHaveLength(0);
  });

  it("ignores excluded nodes", () => {
    const neighbour = node({ id: "a", x: 200, y: 0, width: 100, height: 100 });
    const result = computeSnap({
      moving: { x: 203, y: 300, width: 100, height: 100 },
      candidates: [neighbour],
      threshold: 6,
      excludeIds: new Set(["a"]),
    });
    expect(result.x).toBe(203);
  });

  it("picks the closest candidate when two are in range", () => {
    const near = node({ id: "near", x: 202, y: 0, width: 100, height: 100 });
    const far = node({ id: "far", x: 206, y: 0, width: 100, height: 100 });
    const result = computeSnap({
      moving: { x: 203, y: 300, width: 100, height: 100 },
      candidates: [far, near],
      threshold: 6,
    });
    expect(result.x).toBe(202);
  });

  it("converts the screen threshold to world units by zoom", () => {
    expect(snapThresholdForZoom(1)).toBeCloseTo(6, 6);
    expect(snapThresholdForZoom(2)).toBeCloseTo(3, 6);
    expect(snapThresholdForZoom(0)).toBeCloseTo(6, 6);
  });
});

describe("spatial index", () => {
  it("indexes and queries nodes by viewport", () => {
    const index = new CanvasSpatialIndex();
    index.rebuild([
      node({ id: "inside", x: 0, y: 0 }),
      node({ id: "outside", x: 5000, y: 5000 }),
    ]);
    const hits = index.search({ minX: -10, minY: -10, maxX: 200, maxY: 200 });
    expect(hits).toContain("inside");
    expect(hits).not.toContain("outside");
  });

  it("removes a node from the index", () => {
    const index = new CanvasSpatialIndex();
    index.rebuild([node({ id: "a", x: 0, y: 0 })]);
    expect(index.search({ minX: 0, minY: 0, maxX: 50, maxY: 50 })).toContain("a");
    index.remove("a");
    expect(index.search({ minX: 0, minY: 0, maxX: 50, maxY: 50 })).not.toContain("a");
  });

  it("updates a node's entry on upsert", () => {
    const index = new CanvasSpatialIndex();
    index.rebuild([node({ id: "a", x: 0, y: 0 })]);
    index.upsert(node({ id: "a", x: 900, y: 900 }));
    expect(index.search({ minX: 0, minY: 0, maxX: 50, maxY: 50 })).not.toContain("a");
    expect(index.search({ minX: 880, minY: 880, maxX: 1000, maxY: 1000 })).toContain("a");
  });

  it("indexes a rotated node by its rotated bounds", () => {
    const rotated = node({ id: "r", x: 0, y: 0, width: 100, height: 100, rotation: Math.PI / 4 });
    const entry = entryFor(rotated);
    expect(entry).not.toBeNull();
    // The rotated AABB extends past the unrotated 0..100 box.
    expect(entry!.maxX).toBeGreaterThan(100);
  });

  it("indexes a connector by the union of its endpoints", () => {
    const connector = node({
      id: "c",
      type: "connector",
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      startX: 0,
      startY: 0,
      endX: 800,
      endY: 600,
    });
    const entry = entryFor(connector);
    expect(entry).not.toBeNull();
    expect(entry!.maxX).toBe(800);
    expect(entry!.maxY).toBe(600);
  });

  it("converts a viewport into a world rect", () => {
    const rect = viewportWorldRect({ x: 0, y: 0, zoom: 1 }, { width: 800, height: 600 }, 0);
    // Compared numerically rather than with toEqual: the negation of a zero
    // offset produces -0, which toEqual treats as distinct from 0.
    expect(rect.minX).toBeCloseTo(0, 6);
    expect(rect.minY).toBeCloseTo(0, 6);
    expect(rect.maxX).toBeCloseTo(800, 6);
    expect(rect.maxY).toBeCloseTo(600, 6);
  });

  it("accounts for zoom when converting the viewport", () => {
    const rect = viewportWorldRect({ x: 0, y: 0, zoom: 2 }, { width: 800, height: 600 }, 0);
    expect(rect.maxX).toBe(400);
    expect(rect.maxY).toBe(300);
  });
});
