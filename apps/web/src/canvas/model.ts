import * as Y from "yjs";

import {
  CANVAS_LAYERS,
  CANVAS_NODES,
  CANVAS_COMPONENTS,
  DEFAULT_LAYER_ID,
  DEFAULT_LAYER_NAME,
  NODE_LIMITS,
  clampDimension,
  createCanvasNode,
  isFiniteNumber,
  isNodeType,
  isValidColor,
  sanitizeCanvasText,
  type CanvasLayer,
  type CanvasComponent,
  type CanvasNode,
  type ConnectorHead,
  type CurveType,
  type FrameLayoutAlignment,
  type FrameLayoutDirection,
  type NodeType,
  type PathPoint,
  type PortId,
} from "@trellis/shared";

export const LOCAL_ORIGIN = Symbol("trellis-local-origin");
export const DOCUMENT_INIT_ORIGIN = Symbol("trellis-document-init");

export interface CanvasMaps {
  nodes: Y.Map<Y.Map<unknown>>;
  layers: Y.Map<Y.Map<unknown>>;
  components: Y.Map<Y.Map<unknown>>;
}

export function getCanvasMaps(doc: Y.Doc): CanvasMaps {
  return {
    nodes: doc.getMap<Y.Map<unknown>>(CANVAS_NODES),
    layers: doc.getMap<Y.Map<unknown>>(CANVAS_LAYERS),
    components: doc.getMap<Y.Map<unknown>>(CANVAS_COMPONENTS),
  };
}

export function ensureDefaultLayer(doc: Y.Doc, maps: CanvasMaps): void {
  if (maps.layers.has(DEFAULT_LAYER_ID)) return;
  doc.transact(() => {
    if (maps.layers.has(DEFAULT_LAYER_ID)) return;
    const layer = new Y.Map<unknown>();
    layer.set("id", DEFAULT_LAYER_ID);
    layer.set("name", DEFAULT_LAYER_NAME);
    layer.set("visible", true);
    layer.set("zIndex", 0);
    maps.layers.set(DEFAULT_LAYER_ID, layer);
  }, DOCUMENT_INIT_ORIGIN);
}

export function readLayers(maps: CanvasMaps): CanvasLayer[] {
  const layers: CanvasLayer[] = [];
  maps.layers.forEach((value, key) => {
    if (!(value instanceof Y.Map)) return;
    const rawZIndex = value.get("zIndex");
    layers.push({
      id: typeof value.get("id") === "string" ? (value.get("id") as string) : key,
      name:
        typeof value.get("name") === "string" && (value.get("name") as string).trim().length > 0
          ? (value.get("name") as string).slice(0, 80)
          : "Untitled layer",
      visible: value.get("visible") !== false,
      zIndex: isFiniteNumber(rawZIndex) ? rawZIndex : 0,
    });
  });
  layers.sort(
    (left, right) =>
      left.zIndex - right.zIndex ||
      left.name.localeCompare(right.name) ||
      left.id.localeCompare(right.id),
  );
  return layers;
}

export function readNodes(maps: CanvasMaps): CanvasNode[] {
  const nodes: CanvasNode[] = [];
  maps.nodes.forEach((value, id) => {
    if (!(value instanceof Y.Map)) return;
    const node = readNode(value, id);
    if (node) nodes.push(node);
  });
  nodes.sort((left, right) => left.zIndex - right.zIndex || left.id.localeCompare(right.id));
  return nodes;
}

export function readNode(value: Y.Map<unknown>, id: string): CanvasNode | null {
  const type = value.get("type");
  if (!isNodeType(type)) return null;

  const x = finite(value.get("x"), 0);
  const y = finite(value.get("y"), 0);
  const width = clampDimension(finite(value.get("width"), 160));
  const height = clampDimension(finite(value.get("height"), 100));
  const fill = value.get("fill");
  const stroke = value.get("stroke");
  const layerId = value.get("layerId");
  const text = sanitizeCanvasText(value.get("text"));
  const fontSize = Math.min(
    NODE_LIMITS.maxFontSize,
    Math.max(NODE_LIMITS.minFontSize, finite(value.get("fontSize"), 24)),
  );

  return {
    id: typeof value.get("id") === "string" ? (value.get("id") as string) : id,
    type,
    layerId: typeof layerId === "string" ? layerId : DEFAULT_LAYER_ID,
    x,
    y,
    width,
    height,
    zIndex: finite(value.get("zIndex"), 0),
    fill: isValidColor(fill) ? fill : "#6366f1",
    stroke: isValidColor(stroke) ? stroke : "#c7d2fe",
    strokeWidth: Math.min(
      NODE_LIMITS.maxStroke,
      Math.max(NODE_LIMITS.minStroke, finite(value.get("strokeWidth"), 1)),
    ),
    text,
    fontSize,
    createdBy: typeof value.get("createdBy") === "string" ? (value.get("createdBy") as string) : "",
    updatedAt: finite(value.get("updatedAt"), 0),
    ...readOptionalNodeFields(value),
  };
}

/**
 * Read the optional Phase-1 fields from a Y.Map.
 *
 * Each key is only included when it holds a real value. Under
 * `exactOptionalPropertyTypes` assigning `undefined` explicitly is a type
 * error, and a present-but-undefined key would also round-trip through Yjs as
 * a stored null. Returning a spread keeps `readNode` linear and means a new
 * optional field is added in exactly one place.
 */
function readOptionalNodeFields(value: Y.Map<unknown>): Partial<CanvasNode> {
  const fields: Partial<CanvasNode> = {};

  const rotation = value.get("rotation");
  if (isFiniteNumber(rotation)) fields.rotation = rotation;
  const opacity = value.get("opacity");
  if (isFiniteNumber(opacity)) fields.opacity = opacity;
  const locked = value.get("locked");
  if (typeof locked === "boolean") fields.locked = locked;
  const parentFrameId = value.get("parentFrameId");
  if (typeof parentFrameId === "string") fields.parentFrameId = parentFrameId;
  const componentId = value.get("componentId");
  if (typeof componentId === "string") fields.componentId = componentId;
  const componentSourceNodeId = value.get("componentSourceNodeId");
  if (typeof componentSourceNodeId === "string") {
    fields.componentSourceNodeId = componentSourceNodeId;
  }
  const layoutDirection = value.get("layoutDirection");
  if (layoutDirection === "horizontal" || layoutDirection === "vertical") {
    fields.layoutDirection = layoutDirection;
  }
  const layoutGap = value.get("layoutGap");
  if (isFiniteNumber(layoutGap)) fields.layoutGap = layoutGap;
  const layoutPadding = value.get("layoutPadding");
  if (isFiniteNumber(layoutPadding)) fields.layoutPadding = layoutPadding;
  const layoutAlignment = value.get("layoutAlignment");
  if (layoutAlignment === "start" || layoutAlignment === "center" || layoutAlignment === "end") {
    fields.layoutAlignment = layoutAlignment;
  }

  const points = value.get("points");
  if (Array.isArray(points)) {
    const parsed: PathPoint[] = [];
    for (const point of points) {
      if (
        typeof point === "object" &&
        point !== null &&
        isFiniteNumber((point as { x?: unknown }).x) &&
        isFiniteNumber((point as { y?: unknown }).y)
      ) {
        const record = point as { x: number; y: number; pressure?: unknown };
        const next: PathPoint = { x: record.x, y: record.y };
        if (isFiniteNumber(record.pressure)) next.pressure = record.pressure;
        parsed.push(next);
      }
    }
    if (parsed.length > 0) fields.points = parsed;
  }
  const isClosed = value.get("isClosed");
  if (typeof isClosed === "boolean") fields.isClosed = isClosed;

  const assetId = value.get("assetId");
  if (typeof assetId === "string") fields.assetId = assetId;
  const url = value.get("url");
  if (typeof url === "string") fields.url = url;
  const aspectRatio = value.get("aspectRatio");
  if (isFiniteNumber(aspectRatio)) fields.aspectRatio = aspectRatio;

  const startNodeId = value.get("startNodeId");
  if (typeof startNodeId === "string") fields.startNodeId = startNodeId;
  const startPort = value.get("startPort");
  if (isPortIdLike(startPort)) fields.startPort = startPort;
  const endNodeId = value.get("endNodeId");
  if (typeof endNodeId === "string") fields.endNodeId = endNodeId;
  const endPort = value.get("endPort");
  if (isPortIdLike(endPort)) fields.endPort = endPort;
  const curveType = value.get("curveType");
  if (isCurveTypeLike(curveType)) fields.curveType = curveType;
  const startHead = value.get("startHead");
  if (isConnectorHeadLike(startHead)) fields.startHead = startHead;
  const endHead = value.get("endHead");
  if (isConnectorHeadLike(endHead)) fields.endHead = endHead;
  const startX = value.get("startX");
  if (isFiniteNumber(startX)) fields.startX = startX;
  const startY = value.get("startY");
  if (isFiniteNumber(startY)) fields.startY = startY;
  const endX = value.get("endX");
  if (isFiniteNumber(endX)) fields.endX = endX;
  const endY = value.get("endY");
  if (isFiniteNumber(endY)) fields.endY = endY;

  const aspectPreset = value.get("aspectPreset");
  if (typeof aspectPreset === "string") fields.aspectPreset = aspectPreset;
  const clipContent = value.get("clipContent");
  if (typeof clipContent === "boolean") fields.clipContent = clipContent;

  return fields;
}

function isPortIdLike(value: unknown): value is PortId {
  return value === "n" || value === "s" || value === "e" || value === "w";
}

function isCurveTypeLike(value: unknown): value is CurveType {
  return value === "straight" || value === "curved" || value === "orthogonal";
}

function isConnectorHeadLike(value: unknown): value is ConnectorHead {
  return value === "none" || value === "arrow" || value === "circle" || value === "bar";
}

export function readNodeById(maps: CanvasMaps, nodeId: string): CanvasNode | null {
  const value = maps.nodes.get(nodeId);
  return value instanceof Y.Map ? readNode(value, nodeId) : null;
}

export function getOrderedVisibleNodes(maps: CanvasMaps): CanvasNode[] {
  const nodes = readNodes(maps);
  const ordered: CanvasNode[] = [];
  for (const layer of readLayers(maps)) {
    if (!layer.visible) continue;
    const layerNodes = nodes
      .filter((node) => node.layerId === layer.id)
      .sort((left, right) => left.zIndex - right.zIndex || left.id.localeCompare(right.id));
    ordered.push(...layerNodes);
  }
  return ordered;
}

export interface CreateNodeInput {
  id: string;
  type: NodeType;
  x: number;
  y: number;
  width: number;
  height: number;
  createdBy: string;
  layerId: string;
  text?: string;
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
  fontSize?: number;
  rotation?: number;
  opacity?: number;
  locked?: boolean;
  parentFrameId?: string;
  componentId?: string;
  componentSourceNodeId?: string;
  layoutDirection?: FrameLayoutDirection;
  layoutGap?: number;
  layoutPadding?: number;
  layoutAlignment?: FrameLayoutAlignment;
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
}

export type CanvasNodePatch = Partial<
  Pick<
    CanvasNode,
    | "x"
    | "y"
    | "width"
    | "height"
    | "text"
    | "layerId"
    | "zIndex"
    | "fill"
    | "stroke"
    | "strokeWidth"
    | "fontSize"
    | "rotation"
    | "opacity"
    | "locked"
    | "parentFrameId"
    | "componentId"
    | "componentSourceNodeId"
    | "layoutDirection"
    | "layoutGap"
    | "layoutPadding"
    | "layoutAlignment"
    | "points"
    | "isClosed"
    | "assetId"
    | "url"
    | "aspectRatio"
    | "startNodeId"
    | "startPort"
    | "endNodeId"
    | "endPort"
    | "curveType"
    | "startHead"
    | "endHead"
    | "startX"
    | "startY"
    | "endX"
    | "endY"
    | "aspectPreset"
    | "clipContent"
  >
>;

export function createNode(doc: Y.Doc, maps: CanvasMaps, input: CreateNodeInput): CanvasNode {
  const nodes = readNodes(maps);
  const maxZ = nodes
    .filter((node) => node.layerId === input.layerId)
    .reduce((max, node) => Math.max(max, node.zIndex), 0);
  const node = createCanvasNode({
    ...input,
    text: input.text ?? "",
    zIndex: maxZ + 1,
  });

  doc.transact(() => {
    maps.nodes.set(node.id, createYNode(node));
  }, LOCAL_ORIGIN);
  return node;
}

export function updateNode(
  doc: Y.Doc,
  maps: CanvasMaps,
  nodeId: string,
  fields: CanvasNodePatch,
): void {
  updateNodes(doc, maps, [nodeId], fields);
}

export function updateNodes(
  doc: Y.Doc,
  maps: CanvasMaps,
  nodeIds: readonly string[],
  fields: CanvasNodePatch,
): void {
  if (nodeIds.length === 0) return;
  const targets = new Map<Y.Map<unknown>, boolean>();
  const sharedFields = Object.entries(fields).filter(
    ([key, value]) =>
      value !== undefined &&
      key !== "componentId" &&
      key !== "componentSourceNodeId" &&
      key !== "x" &&
      key !== "y" &&
      key !== "layerId" &&
      key !== "zIndex" &&
      key !== "parentFrameId",
  );
  const appendComponentPeers = (node: Y.Map<unknown>): void => {
    targets.set(node, true);
    const componentId = node.get("componentId");
    const sourceNodeId = node.get("componentSourceNodeId");
    if (typeof componentId !== "string" || typeof sourceNodeId !== "string") return;
    maps.nodes.forEach((candidate) => {
      if (
        candidate instanceof Y.Map &&
        candidate.get("componentId") === componentId &&
        candidate.get("componentSourceNodeId") === sourceNodeId
      ) {
        if (!targets.has(candidate)) targets.set(candidate, false);
      }
    });
  };
  for (const nodeId of nodeIds) {
    const node = maps.nodes.get(nodeId);
    if (node instanceof Y.Map) appendComponentPeers(node);
  }
  if (targets.size === 0) return;
  doc.transact(() => {
    for (const [target, isDirect] of targets) {
      const applicableFields = isDirect ? Object.entries(fields) : sharedFields;
      for (const [key, value] of applicableFields) {
        if (value === undefined) continue;
        target.set(key, value);
      }
      target.set("updatedAt", Date.now());
    }
  }, LOCAL_ORIGIN);
}

export function readComponents(maps: CanvasMaps): CanvasComponent[] {
  const components: CanvasComponent[] = [];
  maps.components.forEach((value, id) => {
    if (!(value instanceof Y.Map)) return;
    const name = value.get("name");
    const rawNodeIds = value.get("nodeIds");
    if (
      typeof name !== "string" ||
      !Array.isArray(rawNodeIds) ||
      !rawNodeIds.every((nodeId) => typeof nodeId === "string")
    ) {
      return;
    }
    const nodeIds = rawNodeIds.filter((nodeId) => {
      const node = maps.nodes.get(nodeId);
      return node instanceof Y.Map && node.get("componentId") === id;
    });
    if (nodeIds.length > 0) components.push({ id, name, nodeIds });
  });
  return components.sort((left, right) => left.name.localeCompare(right.name));
}

export function createComponent(
  doc: Y.Doc,
  maps: CanvasMaps,
  name: string,
  nodeIds: readonly string[],
): CanvasComponent | null {
  const trimmedName = name.trim().slice(0, 80);
  const uniqueIds = Array.from(new Set(nodeIds));
  if (!trimmedName || uniqueIds.length === 0) return null;
  const sourceNodes = uniqueIds.map((id) => readNodeById(maps, id));
  if (sourceNodes.some((node) => !node || node.componentId)) return null;

  const id = crypto.randomUUID();
  const definition: CanvasComponent = { id, name: trimmedName, nodeIds: uniqueIds };
  doc.transact(() => {
    const record = new Y.Map<unknown>();
    record.set("id", id);
    record.set("name", trimmedName);
    record.set("nodeIds", uniqueIds);
    maps.components.set(id, record);
    for (const nodeId of uniqueIds) {
      const node = maps.nodes.get(nodeId);
      if (!(node instanceof Y.Map)) continue;
      node.set("componentId", id);
      node.set("componentSourceNodeId", nodeId);
    }
  }, LOCAL_ORIGIN);
  return definition;
}

export function applyFrameAutoLayout(
  doc: Y.Doc,
  maps: CanvasMaps,
  frameId: string,
  direction: FrameLayoutDirection,
  gap: number,
  padding: number,
  alignment: FrameLayoutAlignment,
): string[] {
  const frame = readNodeById(maps, frameId);
  if (!frame || frame.type !== "frame") return [];
  if (!isFiniteNumber(gap) || !isFiniteNumber(padding)) return [];
  const children = readNodes(maps)
    .filter((node) => node.parentFrameId === frameId && node.type !== "connector")
    .sort((left, right) => left.y - right.y || left.x - right.x || left.zIndex - right.zIndex || left.id.localeCompare(right.id));
  if (children.length === 0) return [];

  const safeGap = Math.max(0, Math.min(256, Math.round(gap)));
  const safePadding = Math.max(0, Math.min(512, Math.round(padding)));
  let cursor = direction === "vertical" ? frame.y + safePadding : frame.x + safePadding;
  const positions = children.map((child) => {
    let x = child.x;
    let y = child.y;
    if (direction === "vertical") {
      y = cursor;
      const availableWidth = Math.max(0, frame.width - safePadding * 2);
      x =
        alignment === "start"
          ? frame.x + safePadding
          : alignment === "center"
            ? frame.x + (frame.width - child.width) / 2
            : frame.x + frame.width - safePadding - child.width;
      if (availableWidth > 0) x = Math.max(frame.x, Math.min(x, frame.x + frame.width - child.width));
      cursor += child.height + safeGap;
    } else {
      x = cursor;
      const availableHeight = Math.max(0, frame.height - safePadding * 2);
      y =
        alignment === "start"
          ? frame.y + safePadding
          : alignment === "center"
            ? frame.y + (frame.height - child.height) / 2
            : frame.y + frame.height - safePadding - child.height;
      if (availableHeight > 0) y = Math.max(frame.y, Math.min(y, frame.y + frame.height - child.height));
      cursor += child.width + safeGap;
    }
    return { id: child.id, x, y };
  });
  doc.transact(() => {
    const targetFrame = maps.nodes.get(frameId);
    if (targetFrame instanceof Y.Map) {
      targetFrame.set("layoutDirection", direction);
      targetFrame.set("layoutGap", safeGap);
      targetFrame.set("layoutPadding", safePadding);
      targetFrame.set("layoutAlignment", alignment);
      targetFrame.set("updatedAt", Date.now());
    }
    for (const position of positions) {
      const node = maps.nodes.get(position.id);
      if (!(node instanceof Y.Map)) continue;
      node.set("x", position.x);
      node.set("y", position.y);
      node.set("updatedAt", Date.now());
    }
  }, LOCAL_ORIGIN);
  return children.map((child) => child.id);
}

export function moveNodes(
  doc: Y.Doc,
  maps: CanvasMaps,
  positions: ReadonlyArray<{ id: string; x: number; y: number }>,
): void {
  if (positions.length === 0) return;
  doc.transact(() => {
    for (const position of positions) {
      const node = maps.nodes.get(position.id);
      if (!(node instanceof Y.Map)) continue;
      node.set("x", position.x);
      node.set("y", position.y);
      node.set("updatedAt", Date.now());
    }
  }, LOCAL_ORIGIN);
}

export function insertNodeCopies(
  doc: Y.Doc,
  maps: CanvasMaps,
  snapshots: readonly CanvasNode[],
  options: {
    createdBy: string;
    fallbackLayerId: string;
    offsetX: number;
    offsetY: number;
  },
): CanvasNode[] {
  if (snapshots.length === 0) return [];
  const layerIds = new Set(readLayers(maps).map((layer) => layer.id));
  const zByLayer = new Map<string, number>();
  for (const node of readNodes(maps)) {
    zByLayer.set(node.layerId, Math.max(zByLayer.get(node.layerId) ?? 0, node.zIndex));
  }
  const created: CanvasNode[] = [];
  const copiedIdBySourceId = new Map(
    snapshots.map((snapshot) => [snapshot.id, crypto.randomUUID()] as const),
  );
  doc.transact(() => {
    for (const snapshot of snapshots) {
      const layerId = layerIds.has(snapshot.layerId) ? snapshot.layerId : options.fallbackLayerId;
      const nextZ = (zByLayer.get(layerId) ?? 0) + 1;
      zByLayer.set(layerId, nextZ);
      const startNodeId = snapshot.startNodeId
        ? copiedIdBySourceId.get(snapshot.startNodeId)
        : undefined;
      const endNodeId = snapshot.endNodeId
        ? copiedIdBySourceId.get(snapshot.endNodeId)
        : undefined;
      const parentFrameId = snapshot.parentFrameId
        ? copiedIdBySourceId.get(snapshot.parentFrameId)
        : undefined;
      const node: CanvasNode = {
        ...snapshot,
        id: copiedIdBySourceId.get(snapshot.id) ?? crypto.randomUUID(),
        layerId,
        x: Math.round(snapshot.x + options.offsetX),
        y: Math.round(snapshot.y + options.offsetY),
        zIndex: nextZ,
        createdBy: options.createdBy,
        updatedAt: Date.now(),
        ...(startNodeId ? { startNodeId } : {}),
        ...(endNodeId ? { endNodeId } : {}),
        ...(parentFrameId ? { parentFrameId } : {}),
      };
      maps.nodes.set(node.id, createYNode(node));
      created.push(node);
    }
  }, LOCAL_ORIGIN);
  return created;
}

export function setLayerVisibility(
  doc: Y.Doc,
  maps: CanvasMaps,
  layerId: string,
  visible: boolean,
): void {
  updateLayer(doc, maps, layerId, { visible });
}

export function updateLayer(
  doc: Y.Doc,
  maps: CanvasMaps,
  layerId: string,
  fields: Partial<Pick<CanvasLayer, "name" | "visible" | "zIndex">>,
): void {
  const layer = maps.layers.get(layerId);
  if (!(layer instanceof Y.Map)) return;
  doc.transact(() => {
    if (fields.name !== undefined) layer.set("name", fields.name.slice(0, 80));
    if (fields.visible !== undefined) layer.set("visible", fields.visible);
    if (fields.zIndex !== undefined) layer.set("zIndex", fields.zIndex);
  }, LOCAL_ORIGIN);
}

export function moveLayer(
  doc: Y.Doc,
  maps: CanvasMaps,
  layerId: string,
  direction: "up" | "down",
): void {
  const layers = readLayers(maps);
  const index = layers.findIndex((layer) => layer.id === layerId);
  if (index < 0) return;
  const targetIndex = direction === "up" ? index + 1 : index - 1;
  if (targetIndex < 0 || targetIndex >= layers.length) return;
  const reordered = [...layers];
  const [moved] = reordered.splice(index, 1);
  if (!moved) return;
  reordered.splice(targetIndex, 0, moved);
  doc.transact(() => {
    reordered.forEach((layer, nextIndex) => {
      const target = maps.layers.get(layer.id);
      if (target instanceof Y.Map) target.set("zIndex", nextIndex);
    });
  }, LOCAL_ORIGIN);
}

export function deleteLayerWithFallback(
  doc: Y.Doc,
  maps: CanvasMaps,
  layerId: string,
  fallbackLayerId: string,
): boolean {
  const layers = readLayers(maps);
  if (layers.length <= 1 || layerId === fallbackLayerId) return false;
  if (!layers.some((layer) => layer.id === layerId)) return false;
  const fallback = layers.find((layer) => layer.id === fallbackLayerId) ?? layers[0];
  if (!fallback) return false;
  const fallbackNodes = readNodes(maps).filter((node) => node.layerId === fallback.id);
  let nextZ = fallbackNodes.reduce((max, node) => Math.max(max, node.zIndex), 0);
  doc.transact(() => {
    for (const node of readNodes(maps)) {
      if (node.layerId !== layerId) continue;
      const target = maps.nodes.get(node.id);
      if (!(target instanceof Y.Map)) continue;
      nextZ += 1;
      target.set("layerId", fallback.id);
      target.set("zIndex", nextZ);
      target.set("updatedAt", Date.now());
    }
    maps.layers.delete(layerId);
  }, LOCAL_ORIGIN);
  return true;
}

export function moveNodesToLayer(
  doc: Y.Doc,
  maps: CanvasMaps,
  nodeIds: readonly string[],
  layerId: string,
): void {
  if (nodeIds.length === 0) return;
  const layerNodes = readNodes(maps).filter((node) => node.layerId === layerId);
  let nextZ = layerNodes.reduce((max, node) => Math.max(max, node.zIndex), 0);
  doc.transact(() => {
    for (const nodeId of nodeIds) {
      const node = maps.nodes.get(nodeId);
      if (!(node instanceof Y.Map)) continue;
      nextZ += 1;
      node.set("layerId", layerId);
      node.set("zIndex", nextZ);
      node.set("updatedAt", Date.now());
    }
  }, LOCAL_ORIGIN);
}

export function reorderNodes(
  doc: Y.Doc,
  maps: CanvasMaps,
  nodeIds: readonly string[],
  direction: "front" | "back",
): void {
  if (nodeIds.length === 0) return;
  const selected = new Set(nodeIds);
  const nodes = readNodes(maps);
  const zByLayer = new Map<string, { min: number; max: number }>();
  for (const node of nodes) {
    const current = zByLayer.get(node.layerId) ?? {
      min: Number.POSITIVE_INFINITY,
      max: Number.NEGATIVE_INFINITY,
    };
    zByLayer.set(node.layerId, {
      min: Math.min(current.min, node.zIndex),
      max: Math.max(current.max, node.zIndex),
    });
  }
  doc.transact(() => {
    const ordered = direction === "front" ? nodes : [...nodes].reverse();
    for (const node of ordered) {
      if (!selected.has(node.id)) continue;
      const bounds = zByLayer.get(node.layerId) ?? { min: 0, max: 0 };
      const target = maps.nodes.get(node.id);
      if (!(target instanceof Y.Map)) continue;
      if (direction === "front") {
        bounds.max += 1;
        target.set("zIndex", bounds.max);
      } else {
        bounds.min -= 1;
        target.set("zIndex", bounds.min);
      }
      zByLayer.set(node.layerId, bounds);
      target.set("updatedAt", Date.now());
    }
  }, LOCAL_ORIGIN);
}

export function reverseDrawOrder(nodes: CanvasNode[]): CanvasNode[] {
  return [...nodes].reverse();
}

export function createYNode(node: CanvasNode): Y.Map<unknown> {
  const yNode = new Y.Map<unknown>();
  for (const [key, value] of Object.entries(node)) {
    yNode.set(key, value);
  }
  return yNode;
}

function finite(value: unknown, fallback: number): number {
  return isFiniteNumber(value) ? value : fallback;
}

export function deleteNodes(doc: Y.Doc, maps: CanvasMaps, nodeIds: readonly string[]): void {
  if (nodeIds.length === 0) return;
  doc.transact(() => {
    for (const nodeId of nodeIds) maps.nodes.delete(nodeId);
  }, LOCAL_ORIGIN);
}

export function addLayer(doc: Y.Doc, maps: CanvasMaps, name?: string): CanvasLayer {
  const layers = readLayers(maps);
  const zIndex = layers.reduce((max, layer) => Math.max(max, layer.zIndex), -1) + 1;
  const layer: CanvasLayer = {
    id: crypto.randomUUID(),
    name: name?.slice(0, 80) || `Layer ${layers.length + 1}`,
    visible: true,
    zIndex,
  };
  doc.transact(() => {
    const yLayer = new Y.Map<unknown>();
    yLayer.set("id", layer.id);
    yLayer.set("name", layer.name);
    yLayer.set("visible", layer.visible);
    yLayer.set("zIndex", layer.zIndex);
    maps.layers.set(layer.id, yLayer);
  }, LOCAL_ORIGIN);
  return layer;
}
