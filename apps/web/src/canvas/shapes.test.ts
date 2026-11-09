import { describe, expect, it } from "vitest";

import { createCanvasNode } from "@trellis/shared";

import { HeuristicProvider, createAiProvider } from "./ai";
import { fuzzyMatch, rankByFuzzy } from "../lib/fuzzy";
import {
  catmullRomPoints,
  connectorEndDirection,
  connectorGeometry,
  resolveConnectorAnchor,
} from "./shapes";

describe("Catmull-Rom spline", () => {
  it("passes through the input points", () => {
    const points = [
      { x: 0, y: 0 },
      { x: 50, y: 50 },
      { x: 100, y: 0 },
    ];
    const curve = catmullRomPoints(points, { segmentsPerSpan: 4 });
    // The first and last emitted points are the original endpoints.
    expect(curve[0]).toEqual({ x: 0, y: 0 });
    expect(curve[curve.length - 1]).toEqual({ x: 100, y: 0 });
  });

  it("emits more points than the input for a smooth curve", () => {
    const points = [
      { x: 0, y: 0 },
      { x: 50, y: 50 },
      { x: 100, y: 0 },
    ];
    const curve = catmullRomPoints(points, { segmentsPerSpan: 8 });
    expect(curve.length).toBeGreaterThan(points.length);
  });

  it("handles degenerate inputs without throwing", () => {
    expect(catmullRomPoints([])).toEqual([]);
    expect(catmullRomPoints([{ x: 5, y: 5 }])).toEqual([{ x: 5, y: 5 }]);
    expect(catmullRomPoints([{ x: 0, y: 0 }, { x: 1, y: 1 }])).toHaveLength(2);
  });
});

describe("connector geometry", () => {
  it("builds a straight line with no control points", () => {
    const geometry = connectorGeometry({ x: 0, y: 0 }, { x: 100, y: 100 }, "straight");
    expect(geometry.control).toBeNull();
    expect(geometry.orthogonal).toBeNull();
  });

  it("builds a cubic bezier for a curved connector", () => {
    const geometry = connectorGeometry({ x: 0, y: 0 }, { x: 100, y: 0 }, "curved");
    expect(geometry.control).not.toBeNull();
    expect(geometry.control!.c1.x).toBeGreaterThan(0);
  });

  it("builds a four-point orthogonal step path", () => {
    const geometry = connectorGeometry({ x: 0, y: 0 }, { x: 100, y: 50 }, "orthogonal");
    expect(geometry.orthogonal).toHaveLength(4);
    // The mid-line sits at the horizontal midpoint.
    expect(geometry.orthogonal![1]!.x).toBe(50);
    expect(geometry.orthogonal![2]!.x).toBe(50);
  });

  it("points the end direction along the final segment", () => {
    const geometry = connectorGeometry({ x: 0, y: 0 }, { x: 100, y: 0 }, "straight");
    const direction = connectorEndDirection(geometry);
    expect(direction.x).toBeCloseTo(1, 6);
    expect(direction.y).toBeCloseTo(0, 6);
  });

  it("resolves an anchor from the target node's port", () => {
    const target = createCanvasNode({
      id: "target",
      type: "rect",
      x: 200,
      y: 200,
      width: 100,
      height: 100,
      createdBy: "u1",
    });
    const connector = createCanvasNode({
      id: "c",
      type: "connector",
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      createdBy: "u1",
      endNodeId: "target",
      endPort: "w",
    });
    const anchor = resolveConnectorAnchor(connector, "end", (id) =>
      id === "target" ? target : null,
    );
    expect(anchor).toEqual({ x: 200, y: 250 });
  });

  it("falls back to stored coordinates when the target is gone", () => {
    const connector = createCanvasNode({
      id: "c",
      type: "connector",
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      createdBy: "u1",
      endNodeId: "missing",
      endX: 42,
      endY: 84,
    });
    const anchor = resolveConnectorAnchor(connector, "end", () => null);
    expect(anchor).toEqual({ x: 42, y: 84 });
  });
});

describe("fuzzy matching", () => {
  it("matches a subsequence", () => {
    expect(fuzzyMatch("note", "Insert sticky note")).not.toBeNull();
  });

  it("rejects a non-subsequence", () => {
    expect(fuzzyMatch("zzz", "Insert sticky note")).toBeNull();
  });

  it("ranks a prefix match above a scattered match", () => {
    const ranked = rankByFuzzy("note", ["Insert sticky note", "Note"], (value) => value);
    expect(ranked[0]?.item).toBe("Note");
  });

  it("returns everything for an empty query", () => {
    const ranked = rankByFuzzy("", ["a", "b"], (value) => value);
    expect(ranked).toHaveLength(2);
  });
});

describe("AI heuristic provider", () => {
  const provider = new HeuristicProvider();

  it("generates a root plus branches and leaves", async () => {
    const specs = await provider.generateMindMap("Quarterly planning");
    expect(specs.length).toBeGreaterThan(1);
    expect(specs[0]?.kind).toBe("root");
    expect(specs.some((spec) => spec.kind === "branch")).toBe(true);
  });

  it("is deterministic for the same topic", async () => {
    const first = await provider.generateMindMap("Roadmap");
    const second = await provider.generateMindMap("Roadmap");
    expect(first).toEqual(second);
  });

  it("arranges notes into columns by leading keyword", async () => {
    const notes = [
      createCanvasNode({
        id: "n1",
        type: "note",
        x: 0,
        y: 0,
        width: 100,
        height: 100,
        createdBy: "u1",
        text: "Pricing needs review",
      }),
      createCanvasNode({
        id: "n2",
        type: "note",
        x: 10,
        y: 10,
        width: 100,
        height: 100,
        createdBy: "u1",
        text: "Pricing is unclear",
      }),
      createCanvasNode({
        id: "n3",
        type: "note",
        x: 20,
        y: 20,
        width: 100,
        height: 100,
        createdBy: "u1",
        text: "Hiring is behind",
      }),
    ];
    const plans = await provider.arrangeSelection(notes);
    expect(plans).toHaveLength(3);
    // The two pricing notes share a column.
    const pricing = plans.filter((plan) => plan.column === "Pricing");
    expect(pricing).toHaveLength(2);
  });

  it("summarizes notes extractively without inventing content", async () => {
    const notes = [
      createCanvasNode({
        id: "n1",
        type: "note",
        x: 0,
        y: 0,
        width: 100,
        height: 100,
        createdBy: "u1",
        text: "Revenue grew 20 percent. Costs stayed flat.",
      }),
    ];
    const summary = await provider.summarizeNotes(notes);
    expect(summary.bullets.length).toBeGreaterThan(0);
    // Every bullet must come from the source text.
    for (const bullet of summary.bullets) {
      expect(notes[0]!.text).toContain(bullet.replace(/[.]$/, ""));
    }
  });

  it("handles empty input gracefully", async () => {
    const summary = await provider.summarizeNotes([]);
    expect(summary.bullets).toHaveLength(0);
  });

  it("defaults to the offline provider with no endpoint", () => {
    expect(createAiProvider(undefined).name).toBe("offline");
    expect(createAiProvider("  ").name).toBe("offline");
    expect(createAiProvider("https://example.test/ai").name).toBe("http");
  });
});
