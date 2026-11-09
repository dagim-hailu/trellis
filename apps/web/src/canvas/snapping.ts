import { nodeBounds, type CanvasNode } from "@trellis/shared";

export interface SnapCandidate {
  /** World-space vertical guide line. */
  x: number;
  /** World-space horizontal guide line. */
  y: number;
}

export interface SnapGuide {
  axis: "x" | "y";
  /** World coordinate of the guide line. */
  position: number;
  /** Extent of the guide, so the overlay can draw a line spanning both boxes. */
  from: number;
  to: number;
  /** Distance in screen pixels that was snapped. */
  distance: number;
}

export interface SnapResult {
  x: number;
  y: number;
  guides: SnapGuide[];
}

/** Snap threshold in screen pixels, converted to world units by the caller. */
export const SNAP_THRESHOLD_PX = 6;

interface Edge {
  position: number;
  kind: "start" | "centre" | "end";
}

function edgesFor(min: number, max: number): Edge[] {
  return [
    { position: min, kind: "start" },
    { position: (min + max) / 2, kind: "centre" },
    { position: max, kind: "end" },
  ];
}

/**
 * Magnetic snapping for a dragged or resized box.
 *
 * The moving box's start/centre/end edges on each axis are compared against the
 * same three edges of every candidate node. The closest match within the
 * threshold wins per axis, and the box is translated by the delta that closes
 * the gap. Guides are returned so the overlay can draw the alignment lines and
 * a distance chip.
 *
 * Pure and side-effect free: all inputs are plain numbers, so this is directly
 * unit testable without a DOM or a canvas.
 */
export function computeSnap(input: {
  /** Moving box in world space. */
  moving: { x: number; y: number; width: number; height: number };
  /** Nodes to snap against. The moving node must already be excluded. */
  candidates: readonly CanvasNode[];
  /** Threshold in world units (screen px divided by zoom). */
  threshold: number;
  /** Optional: restrict to these node ids, e.g. only the current selection. */
  excludeIds?: ReadonlySet<string>;
}): SnapResult {
  const { moving, candidates, threshold } = input;
  const exclude = input.excludeIds ?? new Set<string>();

  const movingLeft = Math.min(moving.x, moving.x + moving.width);
  const movingTop = Math.min(moving.y, moving.y + moving.height);
  const movingRight = Math.max(moving.x, moving.x + moving.width);
  const movingBottom = Math.max(moving.y, moving.y + moving.height);
  const movingXEdges = edgesFor(movingLeft, movingRight);
  const movingYEdges = edgesFor(movingTop, movingBottom);

  let bestX: { delta: number; position: number; otherMin: number; otherMax: number } | null = null;
  let bestY: { delta: number; position: number; otherMin: number; otherMax: number } | null = null;

  for (const candidate of candidates) {
    if (exclude.has(candidate.id)) continue;
    if (candidate.type === "connector") continue;
    const bounds = nodeBounds(candidate);
    const candidateXEdges = edgesFor(bounds.left, bounds.right);
    const candidateYEdges = edgesFor(bounds.top, bounds.bottom);

    for (const movingEdge of movingXEdges) {
      for (const targetEdge of candidateXEdges) {
        const delta = targetEdge.position - movingEdge.position;
        if (Math.abs(delta) > threshold) continue;
        if (!bestX || Math.abs(delta) < Math.abs(bestX.delta)) {
          bestX = {
            delta,
            position: targetEdge.position,
            otherMin: bounds.top,
            otherMax: bounds.bottom,
          };
        }
      }
    }

    for (const movingEdge of movingYEdges) {
      for (const targetEdge of candidateYEdges) {
        const delta = targetEdge.position - movingEdge.position;
        if (Math.abs(delta) > threshold) continue;
        if (!bestY || Math.abs(delta) < Math.abs(bestY.delta)) {
          bestY = {
            delta,
            position: targetEdge.position,
            otherMin: bounds.left,
            otherMax: bounds.right,
          };
        }
      }
    }
  }

  const guides: SnapGuide[] = [];
  let x = moving.x;
  let y = moving.y;

  if (bestX) {
    x += bestX.delta;
    guides.push({
      axis: "x",
      position: bestX.position,
      from: Math.min(movingTop, bestX.otherMin),
      to: Math.max(movingBottom, bestX.otherMax),
      distance: Math.abs(bestX.delta),
    });
  }

  if (bestY) {
    y += bestY.delta;
    guides.push({
      axis: "y",
      position: bestY.position,
      from: Math.min(movingLeft, bestY.otherMin),
      to: Math.max(movingRight, bestY.otherMax),
      distance: Math.abs(bestY.delta),
    });
  }

  return { x, y, guides };
}

/** Convert the screen-pixel threshold into world units for the current zoom. */
export function snapThresholdForZoom(zoom: number): number {
  const safeZoom = zoom <= 0 ? 1 : zoom;
  return SNAP_THRESHOLD_PX / safeZoom;
}
