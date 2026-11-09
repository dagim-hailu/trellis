/**
 * Top-level Y.Maps, named deterministically so offline clients can
 * initialize or edit the same document without racing on nested root types:
 *   doc.getMap(CANVAS_NODES)  : Y.Map<Y.Map> keyed by node id
 *   doc.getMap(CANVAS_LAYERS) : Y.Map<Y.Map> keyed by layer id
 *   doc.getMap(CANVAS_COMPONENTS) : Y.Map<Y.Map> keyed by component id
 */
export const CANVAS_NODES = "nodes";
export const CANVAS_LAYERS = "layers";
export const CANVAS_COMPONENTS = "components";
export const DEFAULT_LAYER_ID = "layer-default";
export const DEFAULT_LAYER_NAME = "Layer 1";

export const NODE_TYPES = [
  "rect",
  "ellipse",
  "text",
  "note",
  "path",
  "image",
  "connector",
  "frame",
] as const;
export type NodeType = (typeof NODE_TYPES)[number];

/** Node types that paint a filled body and can host text. */
export const SHAPE_NODE_TYPES = ["rect", "ellipse", "note", "frame"] as const;

/** Node types whose geometry is derived from other nodes rather than a box. */
export const DERIVED_NODE_TYPES = ["connector"] as const;

export const PORT_IDS = ["n", "s", "e", "w"] as const;
export type PortId = (typeof PORT_IDS)[number];

export const CURVE_TYPES = ["straight", "curved", "orthogonal"] as const;
export type CurveType = (typeof CURVE_TYPES)[number];

export const CONNECTOR_HEADS = ["none", "arrow", "circle", "bar"] as const;
export type ConnectorHead = (typeof CONNECTOR_HEADS)[number];

export interface CanvasLayer {
  id: string;
  name: string;
  visible: boolean;
  zIndex: number;
}

export interface CanvasComponent {
  id: string;
  name: string;
  nodeIds: string[];
}

export type FrameLayoutDirection = "horizontal" | "vertical";
export type FrameLayoutAlignment = "start" | "center" | "end";

export interface PathPoint {
  x: number;
  y: number;
  pressure?: number;
}

/**
 * The persisted CRDT contract. Each node is a Y.Map keyed by node id, while
 * drawing order is derived from layer zIndex then node zIndex. No server code
 * interprets these fields: the CRDT is the merge boundary.
 *
 * Fields are flat and optional rather than a discriminated union on `type`.
 * This is deliberate: the Y.Map is written and read field-by-field, and a
 * union would force every reader to narrow before touching a shared field
 * (x, y, fill, layerId) that all node types have. The type-specific fields are
 * documented per group below and validated by the helpers in this module.
 *
 * IMPORTANT: every optional field here is genuinely absent when unset. Under
 * `exactOptionalPropertyTypes` a field must never be assigned `undefined`
 * explicitly; readers use the `readOptional*` helpers in the web package,
 * which return `T | undefined` without writing the key.
 */
export interface CanvasNode {
  id: string;
  type: NodeType;
  layerId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  zIndex: number;
  fill: string;
  stroke: string;
  strokeWidth: number;
  text: string;
  fontSize: number;
  createdBy: string;
  updatedAt: number;

  // -- universal ------------------------------------------------------------
  /** Clockwise rotation in radians about the node's centre. Default 0. */
  rotation?: number;
  /** 0..1. Default 1. */
  opacity?: number;
  /** When true the node cannot be selected or dragged. */
  locked?: boolean;
  /** Frame that clips and owns this node. */
  parentFrameId?: string;
  /** Shared component definition that this source or instance belongs to. */
  componentId?: string;
  /** Source node identity used to propagate component property edits. */
  componentSourceNodeId?: string;
  layoutDirection?: FrameLayoutDirection;
  layoutGap?: number;
  layoutPadding?: number;
  layoutAlignment?: FrameLayoutAlignment;

  // -- path -----------------------------------------------------------------
  /** Freehand stroke points in world space. */
  points?: PathPoint[];
  /** Whether the stroke closes back to its first point. */
  isClosed?: boolean;

  // -- image ----------------------------------------------------------------
  /** Asset row id in app.assets. Preferred over `url`. */
  assetId?: string;
  /** Direct URL, used when the image is not workspace-hosted. */
  url?: string;
  /** width / height of the source image, for aspect-preserving layout. */
  aspectRatio?: number;

  // -- connector ------------------------------------------------------------
  startNodeId?: string;
  startPort?: PortId;
  endNodeId?: string;
  endPort?: PortId;
  curveType?: CurveType;
  startHead?: ConnectorHead;
  endHead?: ConnectorHead;
  /** Fallback world anchor used when the endpoint node is missing. */
  startX?: number;
  startY?: number;
  endX?: number;
  endY?: number;

  // -- frame ----------------------------------------------------------------
  /** Named aspect preset such as "16:9" or "a4". */
  aspectPreset?: string;
  /** Whether children are clipped to the frame bounds. Default true. */
  clipContent?: boolean;
}

export const DEFAULT_LAYER: CanvasLayer = {
  id: DEFAULT_LAYER_ID,
  name: DEFAULT_LAYER_NAME,
  visible: true,
  zIndex: 0,
};

export const NODE_LIMITS = {
  minSize: 8,
  maxSize: 10_000,
  minStroke: 0,
  maxStroke: 24,
  minFontSize: 8,
  maxFontSize: 160,
  /** Upper bound on a single freehand stroke's point count. */
  maxPoints: 4096,
  /** Two pi: a full turn. Rotation is normalised into [0, maxRotation). */
  maxRotation: Math.PI * 2,
} as const;

const COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;
const MAX_TEXT_LENGTH = 20_000;

export function isValidColor(value: unknown): value is string {
  return typeof value === "string" && COLOR_PATTERN.test(value);
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function isNodeType(value: unknown): value is NodeType {
  return typeof value === "string" && (NODE_TYPES as readonly string[]).includes(value);
}

export function isPortId(value: unknown): value is PortId {
  return typeof value === "string" && (PORT_IDS as readonly string[]).includes(value);
}

export function isCurveType(value: unknown): value is CurveType {
  return typeof value === "string" && (CURVE_TYPES as readonly string[]).includes(value);
}

export function isConnectorHead(value: unknown): value is ConnectorHead {
  return typeof value === "string" && (CONNECTOR_HEADS as readonly string[]).includes(value);
}

export function sanitizeCanvasText(value: unknown): string {
  return typeof value === "string" ? value.slice(0, MAX_TEXT_LENGTH) : "";
}

export function clampDimension(value: number): number {
  return Math.min(NODE_LIMITS.maxSize, Math.max(NODE_LIMITS.minSize, value));
}

export function clampOpacity(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(1, Math.max(0, value));
}

/** Normalise any angle into [0, 2pi). */
export function normalizeRotation(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const turn = NODE_LIMITS.maxRotation;
  const wrapped = value % turn;
  return wrapped < 0 ? wrapped + turn : wrapped;
}

export function clampPoints(points: readonly PathPoint[]): PathPoint[] {
  return points.slice(0, NODE_LIMITS.maxPoints).map((point) => {
    const next: PathPoint = { x: point.x, y: point.y };
    if (isFiniteNumber(point.pressure)) next.pressure = point.pressure;
    return next;
  });
}

export interface Bounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * Axis-aligned bounds of a node in world space.
 *
 * For a rotated node this is the bounds of the rotated box, not the untransformed
 * box, so culling and marquee selection stay correct. Callers that need the
 * unrotated box (resize handles, text layout) should use `unrotatedBounds`.
 */
export function nodeBounds(
  node: Pick<CanvasNode, "x" | "y" | "width" | "height"> & { rotation?: number },
): Bounds {
  const base = unrotatedBounds(node);
  const rotation = normalizeRotation(node.rotation ?? 0);
  if (rotation === 0) return base;

  const centreX = (base.left + base.right) / 2;
  const centreY = (base.top + base.bottom) / 2;
  const halfWidth = (base.right - base.left) / 2;
  const halfHeight = (base.bottom - base.top) / 2;
  const cos = Math.abs(Math.cos(rotation));
  const sin = Math.abs(Math.sin(rotation));
  const extentX = halfWidth * cos + halfHeight * sin;
  const extentY = halfWidth * sin + halfHeight * cos;

  return {
    left: centreX - extentX,
    top: centreY - extentY,
    right: centreX + extentX,
    bottom: centreY + extentY,
  };
}

/** Bounds ignoring rotation. Used for text layout and handle placement. */
export function unrotatedBounds(
  node: Pick<CanvasNode, "x" | "y" | "width" | "height">,
): Bounds {
  const left = Math.min(node.x, node.x + node.width);
  const top = Math.min(node.y, node.y + node.height);
  return {
    left,
    top,
    right: Math.max(node.x, node.x + node.width),
    bottom: Math.max(node.y, node.y + node.height),
  };
}

/** Rotate a world point around a centre by `rotation` radians. */
export function rotatePoint(
  point: { x: number; y: number },
  centre: { x: number; y: number },
  rotation: number,
): { x: number; y: number } {
  if (rotation === 0) return { x: point.x, y: point.y };
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  const dx = point.x - centre.x;
  const dy = point.y - centre.y;
  return {
    x: centre.x + dx * cos - dy * sin,
    y: centre.y + dx * sin + dy * cos,
  };
}

/** Map a world point into a node's unrotated local space. */
export function worldToLocal(
  point: { x: number; y: number },
  node: Pick<CanvasNode, "x" | "y" | "width" | "height"> & { rotation?: number },
): { x: number; y: number } {
  const bounds = unrotatedBounds(node);
  const centre = {
    x: (bounds.left + bounds.right) / 2,
    y: (bounds.top + bounds.bottom) / 2,
  };
  return rotatePoint(point, centre, -normalizeRotation(node.rotation ?? 0));
}

function distanceToSegment(
  point: { x: number; y: number },
  start: { x: number; y: number },
  end: { x: number; y: number },
): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return Math.hypot(point.x - start.x, point.y - start.y);
  let t = ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared;
  t = Math.min(1, Math.max(0, t));
  return Math.hypot(point.x - (start.x + t * dx), point.y - (start.y + t * dy));
}

/** Shortest distance from a point to a polyline. */
export function distanceToPolyline(
  point: { x: number; y: number },
  points: readonly PathPoint[],
  isClosed = false,
): number {
  if (points.length === 0) return Number.POSITIVE_INFINITY;
  if (points.length === 1) {
    const only = points[0]!;
    return Math.hypot(point.x - only.x, point.y - only.y);
  }
  let best = Number.POSITIVE_INFINITY;
  for (let index = 0; index < points.length - 1; index += 1) {
    const start = points[index]!;
    const end = points[index + 1]!;
    best = Math.min(best, distanceToSegment(point, start, end));
  }
  if (isClosed) {
    const first = points[0]!;
    const last = points[points.length - 1]!;
    best = Math.min(best, distanceToSegment(point, last, first));
  }
  return best;
}

export interface HitTestOptions {
  /** Extra tolerance in world units, typically a few screen px divided by zoom. */
  tolerance?: number;
}

/**
 * Whether a world point hits a node.
 *
 * Rotation-aware: the point is mapped into the node's local space first, so a
 * rotated rectangle is tested as an axis-aligned rectangle in local space.
 * Path and connector nodes are tested against their stroke geometry rather than
 * their bounding box, because a diagonal line's box is mostly empty.
 */
export function pointHitsNode(
  node: Pick<CanvasNode, "type" | "x" | "y" | "width" | "height"> & {
    rotation?: number;
    points?: PathPoint[];
    isClosed?: boolean;
    strokeWidth?: number;
  },
  point: { x: number; y: number },
  options: HitTestOptions = {},
): boolean {
  const tolerance = options.tolerance ?? 0;

  if (node.type === "path" && node.points && node.points.length > 0) {
    const strokeAllowance = Math.max(tolerance, (node.strokeWidth ?? 1) / 2 + 2);
    return distanceToPolyline(point, node.points, node.isClosed ?? false) <= strokeAllowance;
  }

  const local = worldToLocal(point, node);
  const bounds = unrotatedBounds(node);
  const pad = tolerance;
  if (
    local.x < bounds.left - pad ||
    local.x > bounds.right + pad ||
    local.y < bounds.top - pad ||
    local.y > bounds.bottom + pad
  ) {
    return false;
  }
  if (node.type !== "ellipse") return true;
  const radiusX = (bounds.right - bounds.left) / 2;
  const radiusY = (bounds.bottom - bounds.top) / 2;
  if (radiusX === 0 || radiusY === 0) return false;
  const normalizedX = (local.x - (bounds.left + radiusX)) / radiusX;
  const normalizedY = (local.y - (bounds.top + radiusY)) / radiusY;
  return normalizedX * normalizedX + normalizedY * normalizedY <= 1;
}

/** Anchor point on a node's border for a connector port. */
export function portPoint(
  node: Pick<CanvasNode, "x" | "y" | "width" | "height"> & { rotation?: number },
  port: PortId,
): { x: number; y: number } {
  const bounds = unrotatedBounds(node);
  const centre = {
    x: (bounds.left + bounds.right) / 2,
    y: (bounds.top + bounds.bottom) / 2,
  };
  const anchor =
    port === "n"
      ? { x: centre.x, y: bounds.top }
      : port === "s"
        ? { x: centre.x, y: bounds.bottom }
        : port === "e"
          ? { x: bounds.right, y: centre.y }
          : { x: bounds.left, y: centre.y };
  return rotatePoint(anchor, centre, normalizeRotation(node.rotation ?? 0));
}

export function createDefaultLayer(): CanvasLayer {
  return { ...DEFAULT_LAYER };
}

/** Per-type visual defaults, so every call site does not repeat a switch. */
export function defaultFillFor(type: NodeType): string {
  switch (type) {
    case "text":
      return "#f8fafc";
    case "note":
      return "#f4c95d";
    case "frame":
      return "#0f172a";
    case "path":
    case "connector":
      return "#6366f1";
    case "image":
      return "#1e293b";
    default:
      return "#6366f1";
  }
}

export function defaultStrokeFor(type: NodeType): string {
  switch (type) {
    case "note":
      return "#d4a73c";
    case "frame":
      return "#334155";
    default:
      return "#c7d2fe";
  }
}

export function defaultStrokeWidthFor(type: NodeType): number {
  switch (type) {
    case "note":
      return 0;
    case "path":
    case "connector":
      return 2;
    case "frame":
      return 1;
    default:
      return 1;
  }
}

export function defaultFontSizeFor(type: NodeType): number {
  switch (type) {
    case "text":
      return 24;
    case "note":
      return 20;
    case "frame":
      return 14;
    default:
      return 16;
  }
}

export function defaultTextFor(type: NodeType): string {
  switch (type) {
    case "text":
      return "Text";
    case "frame":
      return "Frame";
    default:
      return "";
  }
}

export function createCanvasNode(input: {
  id: string;
  type: NodeType;
  x: number;
  y: number;
  width: number;
  height: number;
  createdBy: string;
  layerId?: string;
  zIndex?: number;
  text?: string;
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
  fontSize?: number;
  rotation?: number;
  opacity?: number;
  locked?: boolean;
  parentFrameId?: string;
  points?: PathPoint[];
  isClosed?: boolean;
  assetId?: string;
  url?: string;
  aspectRatio?: number;
  startNodeId?: string;
  startPort?: PortId;
  endNodeId?: string;
  endPort?: PortId;
  curveType?: CurveType;
  startHead?: ConnectorHead;
  endHead?: ConnectorHead;
  startX?: number;
  startY?: number;
  endX?: number;
  endY?: number;
  aspectPreset?: string;
  clipContent?: boolean;
  componentId?: string;
  componentSourceNodeId?: string;
  layoutDirection?: FrameLayoutDirection;
  layoutGap?: number;
  layoutPadding?: number;
  layoutAlignment?: FrameLayoutAlignment;
}): CanvasNode {
  const now = Date.now();
  const node: CanvasNode = {
    id: input.id,
    type: input.type,
    layerId: input.layerId ?? DEFAULT_LAYER_ID,
    x: Math.round(input.x),
    y: Math.round(input.y),
    width: clampDimension(input.width),
    height: clampDimension(input.height),
    zIndex: input.zIndex ?? now,
    fill: isValidColor(input.fill) ? input.fill : defaultFillFor(input.type),
    stroke: isValidColor(input.stroke) ? input.stroke : defaultStrokeFor(input.type),
    strokeWidth:
      input.strokeWidth !== undefined
        ? Math.min(NODE_LIMITS.maxStroke, Math.max(NODE_LIMITS.minStroke, input.strokeWidth))
        : defaultStrokeWidthFor(input.type),
    text: sanitizeCanvasText(input.text ?? defaultTextFor(input.type)),
    fontSize:
      input.fontSize !== undefined
        ? Math.min(NODE_LIMITS.maxFontSize, Math.max(NODE_LIMITS.minFontSize, input.fontSize))
        : defaultFontSizeFor(input.type),
    createdBy: input.createdBy,
    updatedAt: now,
  };

  // Optional fields are only written when they carry a real value. Writing
  // `undefined` would create a key that `exactOptionalPropertyTypes` forbids
  // and that would round-trip through Yjs as a present-but-empty value.
  if (input.rotation !== undefined) node.rotation = normalizeRotation(input.rotation);
  if (input.opacity !== undefined) node.opacity = clampOpacity(input.opacity);
  if (input.locked !== undefined) node.locked = input.locked;
  if (input.parentFrameId !== undefined) node.parentFrameId = input.parentFrameId;
  if (input.points !== undefined) node.points = clampPoints(input.points);
  if (input.isClosed !== undefined) node.isClosed = input.isClosed;
  if (input.assetId !== undefined) node.assetId = input.assetId;
  if (input.url !== undefined) node.url = input.url;
  if (input.aspectRatio !== undefined) node.aspectRatio = input.aspectRatio;
  if (input.startNodeId !== undefined) node.startNodeId = input.startNodeId;
  if (input.startPort !== undefined) node.startPort = input.startPort;
  if (input.endNodeId !== undefined) node.endNodeId = input.endNodeId;
  if (input.endPort !== undefined) node.endPort = input.endPort;
  if (input.curveType !== undefined) node.curveType = input.curveType;
  if (input.startHead !== undefined) node.startHead = input.startHead;
  if (input.endHead !== undefined) node.endHead = input.endHead;
  if (input.startX !== undefined) node.startX = input.startX;
  if (input.startY !== undefined) node.startY = input.startY;
  if (input.endX !== undefined) node.endX = input.endX;
  if (input.endY !== undefined) node.endY = input.endY;
  if (input.aspectPreset !== undefined) node.aspectPreset = input.aspectPreset;
  if (input.clipContent !== undefined) node.clipContent = input.clipContent;
  if (input.componentId !== undefined) node.componentId = input.componentId;
  if (input.componentSourceNodeId !== undefined) {
    node.componentSourceNodeId = input.componentSourceNodeId;
  }
  if (input.layoutDirection !== undefined) node.layoutDirection = input.layoutDirection;
  if (input.layoutGap !== undefined) node.layoutGap = input.layoutGap;
  if (input.layoutPadding !== undefined) node.layoutPadding = input.layoutPadding;
  if (input.layoutAlignment !== undefined) node.layoutAlignment = input.layoutAlignment;

  return node;
}

export function randomPresenceColor(seed: string): string {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) | 0;
  }
  const palette = ["#f97316", "#22c55e", "#06b6d4", "#a855f7", "#ef4444", "#eab308", "#ec4899", "#14b8a6"];
  const paletteIndex = Math.abs(hash) % palette.length;
  return palette[paletteIndex] ?? "#f97316";
}
