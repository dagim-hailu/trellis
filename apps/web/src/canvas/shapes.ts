import {
  normalizeRotation,
  portPoint,
  type CanvasNode,
  type CurveType,
  type PathPoint,
  type PortId,
} from "@trellis/shared";

export interface Vec2 {
  x: number;
  y: number;
}

/**
 * Catmull-Rom spline through the given points, emitted as a flat list of
 * line segments suitable for `ctx.lineTo`.
 *
 * Catmull-Rom is used rather than quadratic smoothing because it passes through
 * every input point, so a freehand stroke stays faithful to what the user drew
 * instead of being pulled toward control-point averages. Tension 0.5 is the
 * standard uniform parameterisation.
 *
 * `segmentsPerSpan` trades smoothness for cost; 8 is visually smooth at typical
 * stroke widths and keeps a 4000-point stroke under 32k segments.
 */
export function catmullRomPoints(
  points: readonly PathPoint[],
  options: { isClosed?: boolean; segmentsPerSpan?: number; tension?: number } = {},
): Vec2[] {
  const segmentsPerSpan = options.segmentsPerSpan ?? 8;
  const tension = options.tension ?? 0.5;
  const isClosed = options.isClosed ?? false;

  if (points.length === 0) return [];
  if (points.length === 1) {
    const only = points[0]!;
    return [{ x: only.x, y: only.y }];
  }
  if (points.length === 2) {
    const first = points[0]!;
    const second = points[1]!;
    return [
      { x: first.x, y: first.y },
      { x: second.x, y: second.y },
    ];
  }

  const output: Vec2[] = [];
  const count = points.length;
  const lastIndex = isClosed ? count : count - 1;

  for (let index = 0; index < lastIndex; index += 1) {
    const p0 = points[wrapIndex(index - 1, count, isClosed)]!;
    const p1 = points[wrapIndex(index, count, isClosed)]!;
    const p2 = points[wrapIndex(index + 1, count, isClosed)]!;
    const p3 = points[wrapIndex(index + 2, count, isClosed)]!;

    const cp1 = {
      x: p1.x + ((p2.x - p0.x) / 6) * tension * 2,
      y: p1.y + ((p2.y - p0.y) / 6) * tension * 2,
    };
    const cp2 = {
      x: p2.x - ((p3.x - p1.x) / 6) * tension * 2,
      y: p2.y - ((p3.y - p1.y) / 6) * tension * 2,
    };

    for (let step = 0; step < segmentsPerSpan; step += 1) {
      const t = step / segmentsPerSpan;
      output.push(cubicAt(p1, cp1, cp2, p2, t));
    }
  }

  const finalPoint = points[isClosed ? 0 : count - 1]!;
  output.push({ x: finalPoint.x, y: finalPoint.y });
  return output;
}

function wrapIndex(index: number, count: number, isClosed: boolean): number {
  if (isClosed) return ((index % count) + count) % count;
  return Math.min(count - 1, Math.max(0, index));
}

function cubicAt(p0: Vec2, p1: Vec2, p2: Vec2, p3: Vec2, t: number): Vec2 {
  const mt = 1 - t;
  const a = mt * mt * mt;
  const b = 3 * mt * mt * t;
  const c = 3 * mt * t * t;
  const d = t * t * t;
  return {
    x: a * p0.x + b * p1.x + c * p2.x + d * p3.x,
    y: a * p0.y + b * p1.y + c * p2.y + d * p3.y,
  };
}

/** Anchor for one end of a connector, resolved from the endpoint node. */
export function resolveConnectorAnchor(
  node: CanvasNode,
  side: "start" | "end",
  lookup: (nodeId: string) => CanvasNode | null,
): Vec2 | null {
  const nodeId = side === "start" ? node.startNodeId : node.endNodeId;
  const port: PortId = (side === "start" ? node.startPort : node.endPort) ?? (side === "start" ? "e" : "w");
  const fallbackX = side === "start" ? node.startX : node.endX;
  const fallbackY = side === "start" ? node.startY : node.endY;

  if (nodeId) {
    const target = lookup(nodeId);
    if (target) return portPoint(target, port);
  }
  if (typeof fallbackX === "number" && typeof fallbackY === "number") {
    return { x: fallbackX, y: fallbackY };
  }
  return null;
}

export interface ConnectorGeometry {
  start: Vec2;
  end: Vec2;
  /** Control points for a cubic bezier, or null for a straight line. */
  control: { c1: Vec2; c2: Vec2 } | null;
  /** Orthogonal polyline, used instead of the bezier when curveType is orthogonal. */
  orthogonal: Vec2[] | null;
}

/**
 * Geometry for a connector between two anchors.
 *
 * - straight: direct line.
 * - curved: cubic bezier whose control points extend along the dominant axis,
 *   which produces the familiar smooth "elbow-less" wire.
 * - orthogonal: a three-segment step path with a mid-line at the horizontal
 *   midpoint, the conventional flowchart routing.
 */
export function connectorGeometry(
  start: Vec2,
  end: Vec2,
  curveType: CurveType = "straight",
): ConnectorGeometry {
  if (curveType === "orthogonal") {
    const midX = (start.x + end.x) / 2;
    return {
      start,
      end,
      control: null,
      orthogonal: [
        { x: start.x, y: start.y },
        { x: midX, y: start.y },
        { x: midX, y: end.y },
        { x: end.x, y: end.y },
      ],
    };
  }

  if (curveType === "curved") {
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const horizontal = Math.abs(dx) >= Math.abs(dy);
    const offset = Math.min(160, Math.max(40, Math.hypot(dx, dy) * 0.4));
    const c1 = horizontal
      ? { x: start.x + Math.sign(dx || 1) * offset, y: start.y }
      : { x: start.x, y: start.y + Math.sign(dy || 1) * offset };
    const c2 = horizontal
      ? { x: end.x - Math.sign(dx || 1) * offset, y: end.y }
      : { x: end.x, y: end.y - Math.sign(dy || 1) * offset };
    return { start, end, control: { c1, c2 }, orthogonal: null };
  }

  return { start, end, control: null, orthogonal: null };
}

/** Unit direction at the end of a connector, for orienting the arrow head. */
export function connectorEndDirection(geometry: ConnectorGeometry): Vec2 {
  const { start, end, control, orthogonal } = geometry;
  if (orthogonal && orthogonal.length >= 2) {
    const last = orthogonal[orthogonal.length - 1]!;
    const previous = orthogonal[orthogonal.length - 2]!;
    return normalize({ x: last.x - previous.x, y: last.y - previous.y });
  }
  if (control) {
    // Tangent of a cubic bezier at t=1 is (end - c2).
    return normalize({ x: end.x - control.c2.x, y: end.y - control.c2.y });
  }
  return normalize({ x: end.x - start.x, y: end.y - start.y });
}

/** Unit direction at the start of a connector, for orienting the start head. */
export function connectorStartDirection(geometry: ConnectorGeometry): Vec2 {
  const { start, end, control, orthogonal } = geometry;
  if (orthogonal && orthogonal.length >= 2) {
    const first = orthogonal[0]!;
    const second = orthogonal[1]!;
    return normalize({ x: first.x - second.x, y: first.y - second.y });
  }
  if (control) {
    return normalize({ x: start.x - control.c1.x, y: start.y - control.c1.y });
  }
  return normalize({ x: start.x - end.x, y: start.y - end.y });
}

function normalize(vector: Vec2): Vec2 {
  const length = Math.hypot(vector.x, vector.y);
  if (length === 0) return { x: 1, y: 0 };
  return { x: vector.x / length, y: vector.y / length };
}

/**
 * The four corner points of a rotated node, in world space.
 * Used for drawing selection chrome that follows rotation.
 */
export function rotatedCorners(node: CanvasNode): Vec2[] {
  const rotation = normalizeRotation(node.rotation ?? 0);
  const left = Math.min(node.x, node.x + node.width);
  const top = Math.min(node.y, node.y + node.height);
  const right = Math.max(node.x, node.x + node.width);
  const bottom = Math.max(node.y, node.y + node.height);
  const centre = { x: (left + right) / 2, y: (top + bottom) / 2 };
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  const rotate = (point: Vec2): Vec2 => {
    const dx = point.x - centre.x;
    const dy = point.y - centre.y;
    return {
      x: centre.x + dx * cos - dy * sin,
      y: centre.y + dx * sin + dy * cos,
    };
  };
  return [
    rotate({ x: left, y: top }),
    rotate({ x: right, y: top }),
    rotate({ x: right, y: bottom }),
    rotate({ x: left, y: bottom }),
  ];
}
