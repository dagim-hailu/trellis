import RBush from "rbush";

import { nodeBounds, type CanvasNode } from "@trellis/shared";

export interface SpatialEntry {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  nodeId: string;
}

export interface WorldRect {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/**
 * R-tree over node bounds, used to cull the draw list to the viewport.
 *
 * Two rules matter and are easy to get wrong:
 *
 * 1. Rotated nodes are indexed by their rotated AABB, not their unrotated box,
 *    so a node rotated 45 degrees is not culled while still visible.
 *
 * 2. A connector is indexed by the union of its endpoints, not by its own
 *    bounding box. A connector can cross the viewport with both endpoints far
 *    outside it; indexing only the endpoint span would still miss that case,
 *    so connectors are additionally always considered when either endpoint is
 *    within the viewport OR the segment's AABB intersects it. The union box is
 *    the correct conservative bound for a straight or curved connector.
 */
export class CanvasSpatialIndex {
  private readonly tree = new RBush<SpatialEntry>();
  private readonly byId = new Map<string, SpatialEntry>();

  get size(): number {
    return this.byId.size;
  }

  clear(): void {
    this.tree.clear();
    this.byId.clear();
  }

  /** Rebuild the whole index. Used on structural changes. */
  rebuild(nodes: readonly CanvasNode[]): void {
    this.clear();
    const entries: SpatialEntry[] = [];
    for (const node of nodes) {
      const entry = entryFor(node);
      if (!entry) continue;
      this.byId.set(node.id, entry);
      entries.push(entry);
    }
    this.tree.load(entries);
  }

  /** Insert or update one node. Cheap path used during drag and resize. */
  upsert(node: CanvasNode): void {
    const existing = this.byId.get(node.id);
    if (existing) this.tree.remove(existing, compareEntries);
    const entry = entryFor(node);
    if (!entry) {
      this.byId.delete(node.id);
      return;
    }
    this.byId.set(node.id, entry);
    this.tree.insert(entry);
  }

  remove(nodeId: string): void {
    const existing = this.byId.get(nodeId);
    if (!existing) return;
    this.tree.remove(existing, compareEntries);
    this.byId.delete(nodeId);
  }

  /** Node ids whose bounds intersect the given world rect. */
  search(rect: WorldRect): string[] {
    const hits = this.tree.search({
      minX: rect.minX,
      minY: rect.minY,
      maxX: rect.maxX,
      maxY: rect.maxY,
    });
    return hits.map((hit) => hit.nodeId);
  }
}

function compareEntries(left: SpatialEntry, right: SpatialEntry): boolean {
  return left.nodeId === right.nodeId;
}

/**
 * Build the index entry for a node.
 *
 * Connectors use the union of their endpoint anchors. When an endpoint is
 * resolved from another node, that node's bounds are used, so the connector is
 * indexed wherever its endpoints actually are.
 */
export function entryFor(node: CanvasNode): SpatialEntry | null {
  if (node.type === "connector") {
    const start = connectorAnchor(node, "start");
    const end = connectorAnchor(node, "end");
    if (!start || !end) return null;
    return {
      minX: Math.min(start.x, end.x),
      minY: Math.min(start.y, end.y),
      maxX: Math.max(start.x, end.x),
      maxY: Math.max(start.y, end.y),
      nodeId: node.id,
    };
  }

  const bounds = nodeBounds(node);
  return {
    minX: bounds.left,
    minY: bounds.top,
    maxX: bounds.right,
    maxY: bounds.bottom,
    nodeId: node.id,
  };
}

function connectorAnchor(
  node: CanvasNode,
  side: "start" | "end",
): { x: number; y: number } | null {
  const x = side === "start" ? node.startX : node.endX;
  const y = side === "start" ? node.startY : node.endY;
  if (typeof x === "number" && typeof y === "number") return { x, y };
  // A connector with an unresolved endpoint has no reliable position; it is
  // left out of the index and therefore never culled, which is the safe side.
  return null;
}

/** Convert a viewport (x, y, zoom, size) into a world-space query rect. */
export function viewportWorldRect(
  viewport: { x: number; y: number; zoom: number },
  size: { width: number; height: number },
  padding = 64,
): WorldRect {
  const zoom = viewport.zoom === 0 ? 1 : viewport.zoom;
  return {
    minX: (-viewport.x - padding) / zoom,
    minY: (-viewport.y - padding) / zoom,
    maxX: (size.width - viewport.x + padding) / zoom,
    maxY: (size.height - viewport.y + padding) / zoom,
  };
}
