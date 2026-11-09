import { describe, expect, it } from "vitest";

import {
  fitRectInViewport,
  hitTestHandle,
  nodesInRect,
  normalizeRect,
  resizeRect,
  zoomViewportAtCenter,
} from "./geometry";

describe("canvas geometry", () => {
  it("normalizes a marquee in any drag direction", () => {
    expect(normalizeRect({ x: 100, y: 80 }, { x: 40, y: 20 })).toEqual({
      x: 40,
      y: 20,
      width: 60,
      height: 60,
    });
  });

  it("selects intersecting nodes only", () => {
    const nodes = [
      { id: "a", x: 0, y: 0, width: 20, height: 20 },
      { id: "b", x: 100, y: 100, width: 20, height: 20 },
    ];
    expect(nodesInRect(nodes, { x: 10, y: 10, width: 20, height: 20 }).map((n) => n.id)).toEqual([
      "a",
    ]);
  });

  it("finds resize handles at the expected edges and tolerance", () => {
    const rect = { x: 20, y: 30, width: 200, height: 100 };
    expect(hitTestHandle(rect, { x: 220, y: 130 }, 8)).toBe("se");
    expect(hitTestHandle(rect, { x: 120, y: 130 }, 8)).toBe("s");
    expect(hitTestHandle(rect, { x: 120, y: 80 }, 8)).toBeNull();
  });

  it("resizes from a corner and keeps the opposite edge anchored", () => {
    const resized = resizeRect(
      { x: 20, y: 30, width: 100, height: 80 },
      "se",
      { x: 180, y: 150 },
      { minSize: 8, maxSize: 1000 },
    );
    expect(resized).toEqual({ x: 20, y: 30, width: 160, height: 120 });
  });

  it("enforces the minimum size when crossing an anchor", () => {
    const resized = resizeRect(
      { x: 20, y: 30, width: 100, height: 80 },
      "e",
      { x: -100, y: 60 },
      { minSize: 8, maxSize: 1000 },
    );
    expect(resized.width).toBe(8);
    expect(resized.x).toBe(20);
  });

  it("fits content in a viewport with padding and center", () => {
    const viewport = fitRectInViewport(
      { x: 0, y: 0, width: 100, height: 50 },
      { width: 400, height: 300 },
      50,
    );
    expect(viewport.zoom).toBe(2);
    expect(viewport.x).toBe(100);
    expect(viewport.y).toBe(100);
  });

  it("zooms at the viewport center without changing the center world point", () => {
    const before = { x: 50, y: 20, zoom: 1 };
    const after = zoomViewportAtCenter(before, { width: 800, height: 600 }, 2);
    expect(after.zoom).toBe(2);
    expect((400 - after.x) / after.zoom).toBe((400 - before.x) / before.zoom);
    expect((300 - after.y) / after.zoom).toBe((300 - before.y) / before.zoom);
  });
});
