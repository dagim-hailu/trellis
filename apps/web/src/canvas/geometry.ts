export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type ResizeHandle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

export const RESIZE_HANDLES: readonly ResizeHandle[] = [
  "nw",
  "n",
  "ne",
  "e",
  "se",
  "s",
  "sw",
  "w",
];

export const HANDLE_CURSORS: Readonly<Record<ResizeHandle, string>> = {
  nw: "nwse-resize",
  n: "ns-resize",
  ne: "nesw-resize",
  e: "ew-resize",
  se: "nwse-resize",
  s: "ns-resize",
  sw: "nesw-resize",
  w: "ew-resize",
};

export const ZOOM_MIN = 0.2;
export const ZOOM_MAX = 4;

export function normalizeRect(start: Point, end: Point): Rect {
  return {
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y),
  };
}

export function rectContainsPoint(rect: Rect, point: Point): boolean {
  return (
    point.x >= rect.x &&
    point.x <= rect.x + rect.width &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.height
  );
}

export function rectsIntersect(left: Rect, right: Rect): boolean {
  return (
    left.x < right.x + right.width &&
    left.x + left.width > right.x &&
    left.y < right.y + right.height &&
    left.y + left.height > right.y
  );
}

export function nodesInRect<T extends Rect>(nodes: readonly T[], selection: Rect): T[] {
  return nodes.filter((node) => rectsIntersect(node, selection));
}

export function unionRects(rects: readonly Rect[]): Rect | null {
  if (rects.length === 0) return null;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const rect of rects) {
    minX = Math.min(minX, rect.x);
    minY = Math.min(minY, rect.y);
    maxX = Math.max(maxX, rect.x + rect.width);
    maxY = Math.max(maxY, rect.y + rect.height);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export function handlePoint(rect: Rect, handle: ResizeHandle): Point {
  const x =
    handle.includes("w")
      ? rect.x
      : handle.includes("e")
        ? rect.x + rect.width
        : rect.x + rect.width / 2;
  const y =
    handle.includes("n")
      ? rect.y
      : handle.includes("s")
        ? rect.y + rect.height
        : rect.y + rect.height / 2;
  return { x, y };
}

export function hitTestHandle(
  rect: Rect,
  point: Point,
  tolerance: number,
): ResizeHandle | null {
  for (const handle of RESIZE_HANDLES) {
    const target = handlePoint(rect, handle);
    if (Math.abs(target.x - point.x) <= tolerance && Math.abs(target.y - point.y) <= tolerance) {
      return handle;
    }
  }
  return null;
}

export interface ResizeOptions {
  minSize?: number;
  maxSize?: number;
  preserveAspect?: boolean;
}

export function resizeRect(
  original: Rect,
  handle: ResizeHandle,
  pointer: Point,
  options: ResizeOptions = {},
): Rect {
  const minSize = options.minSize ?? 8;
  const maxSize = options.maxSize ?? 10_000;
  const fromWest = handle.includes("w");
  const fromEast = handle.includes("e");
  const fromNorth = handle.includes("n");
  const fromSouth = handle.includes("s");

  const anchorX = fromWest ? original.x + original.width : original.x;
  const anchorY = fromNorth ? original.y + original.height : original.y;

  let left = fromWest ? pointer.x : original.x;
  let right = fromEast ? pointer.x : original.x + original.width;
  let top = fromNorth ? pointer.y : original.y;
  let bottom = fromSouth ? pointer.y : original.y + original.height;

  if (!fromWest && !fromEast) {
    left = original.x;
    right = original.x + original.width;
  }
  if (!fromNorth && !fromSouth) {
    top = original.y;
    bottom = original.y + original.height;
  }

  if (options.preserveAspect && (fromWest || fromEast) && (fromNorth || fromSouth)) {
    const aspect = Math.max(0.001, original.width / Math.max(1, original.height));
    const rawWidth = Math.max(minSize, Math.abs(pointer.x - anchorX));
    const rawHeight = Math.max(minSize, Math.abs(pointer.y - anchorY));
    const widthDrift = Math.abs(rawWidth - original.width) / Math.max(1, original.width);
    const heightDrift = Math.abs(rawHeight - original.height) / Math.max(1, original.height);

    let width = rawWidth;
    let height = rawHeight;
    if (widthDrift >= heightDrift) {
      height = width / aspect;
    } else {
      width = height * aspect;
    }
    width = Math.min(maxSize, Math.max(minSize, width));
    height = Math.min(maxSize, Math.max(minSize, height));

    return {
      x: Math.round(fromWest ? anchorX - width : anchorX),
      y: Math.round(fromNorth ? anchorY - height : anchorY),
      width: Math.round(width),
      height: Math.round(height),
    };
  }

  let width = Math.min(maxSize, Math.max(minSize, right - left));
  let height = Math.min(maxSize, Math.max(minSize, bottom - top));
  if (fromWest) left = right - width;
  else right = left + width;
  if (fromNorth) top = bottom - height;
  else bottom = top + height;
  width = Math.min(maxSize, Math.max(minSize, right - left));
  height = Math.min(maxSize, Math.max(minSize, bottom - top));

  return {
    x: Math.round(left),
    y: Math.round(top),
    width: Math.round(width),
    height: Math.round(height),
  };
}

export function fitRectInViewport(
  rect: Rect,
  viewport: { width: number; height: number },
  padding: number,
): { x: number; y: number; zoom: number } {
  const availableWidth = Math.max(1, viewport.width - padding * 2);
  const availableHeight = Math.max(1, viewport.height - padding * 2);
  const rawZoom = Math.min(
    availableWidth / Math.max(1, rect.width),
    availableHeight / Math.max(1, rect.height),
  );
  const zoom = Math.min(2, Math.max(ZOOM_MIN, rawZoom));
  return {
    x: viewport.width / 2 - (rect.x + rect.width / 2) * zoom,
    y: viewport.height / 2 - (rect.y + rect.height / 2) * zoom,
    zoom,
  };
}

export function zoomViewportAt(
  viewport: { x: number; y: number; zoom: number },
  screenPoint: Point,
  factor: number,
): { x: number; y: number; zoom: number } {
  const zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, viewport.zoom * factor));
  const worldX = (screenPoint.x - viewport.x) / viewport.zoom;
  const worldY = (screenPoint.y - viewport.y) / viewport.zoom;
  return {
    x: screenPoint.x - worldX * zoom,
    y: screenPoint.y - worldY * zoom,
    zoom,
  };
}

export function zoomViewportAtCenter(
  viewport: { x: number; y: number; zoom: number },
  viewportSize: { width: number; height: number },
  factor: number,
): { x: number; y: number; zoom: number } {
  return zoomViewportAt(viewport, { x: viewportSize.width / 2, y: viewportSize.height / 2 }, factor);
}

export function resetViewportAtCenter(
  viewport: { x: number; y: number; zoom: number },
  viewportSize: { width: number; height: number },
): { x: number; y: number; zoom: number } {
  return zoomViewportAt(viewport, { x: viewportSize.width / 2, y: viewportSize.height / 2 }, 1 / viewport.zoom);
}
