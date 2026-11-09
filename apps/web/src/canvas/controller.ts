import type { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";

import {
  DEFAULT_LAYER_ID,
  NODE_LIMITS,
  clampDimension,
  pointHitsNode,
  type AssetDto,
  type CanvasLayer,
  type CanvasComponent,
  type CanvasNode,
  type FrameLayoutAlignment,
  type FrameLayoutDirection,
} from "@trellis/shared";

import { CANVAS_THEMES } from "@/lib/theme-config";

import {
  HANDLE_CURSORS,
  fitRectInViewport,
  hitTestHandle,
  normalizeRect,
  nodesInRect,
  resizeRect,
  unionRects,
  zoomViewportAt,
  zoomViewportAtCenter,
  type Rect,
  type ResizeHandle,
} from "./geometry";
import {
  LOCAL_ORIGIN,
  addLayer,
  applyFrameAutoLayout,
  createComponent as createComponentModel,
  createNode,
  deleteLayerWithFallback,
  deleteNodes,
  getOrderedVisibleNodes,
  insertNodeCopies,
  moveLayer as moveLayerY,
  moveNodes,
  moveNodesToLayer,
  readLayers,
  readComponents,
  readNodeById,
  reorderNodes,
  reverseDrawOrder,
  setLayerVisibility as setLayerVisibilityY,
  updateLayer,
  updateNode,
  updateNodes,
  type CanvasMaps,
  type CanvasNodePatch,
} from "./model";
import type { CanvasRenderer, DraftShape } from "./renderer";
import type { CanvasTool, CanvasUiStore, Viewport } from "./store";

interface CanvasControllerOptions {
  canvas: HTMLCanvasElement;
  doc: Y.Doc;
  maps: CanvasMaps;
  awareness: Awareness;
  store: CanvasUiStore;
  renderer: CanvasRenderer;
  user: { id: string; name: string };
  readOnly: boolean;
  onEditText: (nodeId: string, initialText: string) => void;
  /** Called when the comment tool is clicked, with the world-space anchor. */
  onCommentPlace?: (x: number, y: number) => void;
}

interface DragStart {
  id: string;
  x: number;
  y: number;
}

interface DragState {
  nodes: DragStart[];
  startWorld: { x: number; y: number };
  pendingWorld: { x: number; y: number } | null;
  frame: number;
}

interface ResizeState {
  nodeId: string;
  handle: ResizeHandle;
  startRect: Rect;
  pendingWorld: { x: number; y: number } | null;
  preserveAspect: boolean;
  frame: number;
}

interface PanState {
  startClientX: number;
  startClientY: number;
  startViewport: Viewport;
}

interface DrawState {
  startWorld: { x: number; y: number };
  type: "rect" | "ellipse" | "note" | "frame";
  draft: DraftShape | null;
}

interface PathDrawState {
  points: { x: number; y: number }[];
}

interface ConnectorDrawState {
  startWorld: { x: number; y: number };
  startNodeId: string | null;
  startPort: "n" | "s" | "e" | "w";
  currentWorld: { x: number; y: number };
}

interface MarqueeState {
  startWorld: { x: number; y: number };
  currentWorld: { x: number; y: number };
  baseSelection: string[];
}

const MIN_DRAW_SIZE = 8;
const HANDLE_HIT_PX = 11;

export class CanvasController {
  private readonly undoManager: Y.UndoManager;
  private readonly nodesReconcile: () => void;
  private readonly layersReconcile: () => void;
  private interaction: "idle" | "pan" | "drag" | "resize" | "draw" | "marquee" | "path" | "connector" =
    "idle";
  private drag: DragState | null = null;
  private resize: ResizeState | null = null;
  private pan: PanState | null = null;
  private draw: DrawState | null = null;
  private pathDraw: PathDrawState | null = null;
  private connectorDraw: ConnectorDrawState | null = null;
  private marquee: MarqueeState | null = null;
  private cursorFrame = 0;
  private pendingCursor: { x: number; y: number } | null = null;
  private copyBuffer: CanvasNode[] = [];
  private pasteGeneration = 0;
  private spacePressed = false;
  private destroyed = false;

  constructor(private readonly options: CanvasControllerOptions) {
    this.undoManager = new Y.UndoManager(
      [options.maps.nodes, options.maps.layers, options.maps.components],
      {
      trackedOrigins: new Set([LOCAL_ORIGIN]),
      captureTimeout: 400,
      },
    );

    this.nodesReconcile = () => {
      const selected = options.store.getState().selectedNodeIds;
      const stillPresent = selected.filter((nodeId) => options.maps.nodes.has(nodeId));
      if (stillPresent.length !== selected.length) this.setSelection(stillPresent);
    };

    this.layersReconcile = () => {
      const visibleLayers = new Set(
        readLayers(options.maps)
          .filter((layer) => layer.visible)
          .map((layer) => layer.id),
      );
      const selected = options.store.getState().selectedNodeIds;
      const visibleSelection = selected.filter((nodeId) => {
        const node = readNodeById(options.maps, nodeId);
        return node !== null && visibleLayers.has(node.layerId);
      });
      if (visibleSelection.length !== selected.length) this.setSelection(visibleSelection);
    };
  }

  start(): void {
    const { canvas, awareness } = this.options;
    awareness.setLocalStateField("selection", []);
    canvas.addEventListener("pointerdown", this.onPointerDown);
    canvas.addEventListener("pointermove", this.onPointerMove);
    canvas.addEventListener("pointerup", this.onPointerUp);
    canvas.addEventListener("pointercancel", this.onPointerCancel);
    canvas.addEventListener("pointerleave", this.onPointerLeave);
    canvas.addEventListener("dblclick", this.onDoubleClick);
    canvas.addEventListener("wheel", this.onWheel, { passive: false });
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("blur", this.onWindowBlur);
    this.options.maps.nodes.observe(this.nodesReconcile);
    this.options.maps.layers.observeDeep(this.layersReconcile);
    this.setBaseCursor();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    const { canvas, maps, awareness } = this.options;
    canvas.removeEventListener("pointerdown", this.onPointerDown);
    canvas.removeEventListener("pointermove", this.onPointerMove);
    canvas.removeEventListener("pointerup", this.onPointerUp);
    canvas.removeEventListener("pointercancel", this.onPointerCancel);
    canvas.removeEventListener("pointerleave", this.onPointerLeave);
    canvas.removeEventListener("dblclick", this.onDoubleClick);
    canvas.removeEventListener("wheel", this.onWheel);
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    window.removeEventListener("blur", this.onWindowBlur);
    maps.nodes.unobserve(this.nodesReconcile);
    maps.layers.unobserveDeep(this.layersReconcile);
    if (this.cursorFrame) window.cancelAnimationFrame(this.cursorFrame);
    if (this.drag?.frame) window.cancelAnimationFrame(this.drag.frame);
    if (this.resize?.frame) window.cancelAnimationFrame(this.resize.frame);
    this.undoManager.destroy();
    awareness.setLocalStateField("cursor", null);
    awareness.setLocalStateField("selection", []);
  }

  setSelection(nodeIds: string[]): void {
    const unique = Array.from(new Set(nodeIds));
    this.options.store.getState().setSelectedNodeIds(unique);
    this.options.awareness.setLocalStateField("selection", unique);
    this.setBaseCursor();
  }

  getSelectedNodes(): CanvasNode[] {
    const selected = this.options.store.getState().selectedNodeIds;
    return selected
      .map((nodeId) => readNodeById(this.options.maps, nodeId))
      .filter((node): node is CanvasNode => node !== null);
  }

  getNode(nodeId: string): CanvasNode | null {
    return readNodeById(this.options.maps, nodeId);
  }

  /** Every visible node in draw order. Used by the palette and AI actions. */
  getAllNodes(): CanvasNode[] {
    return getOrderedVisibleNodes(this.options.maps);
  }

  getComponents(): CanvasComponent[] {
    return readComponents(this.options.maps);
  }

  createComponent(name: string): CanvasComponent | null {
    if (this.options.readOnly) return null;
    const component = createComponentModel(
      this.options.doc,
      this.options.maps,
      name,
      this.selectedIds(),
    );
    if (component) this.options.renderer.markDirty("scene");
    return component;
  }

  insertComponent(componentId: string): string[] {
    if (this.options.readOnly) return [];
    const component = readComponents(this.options.maps).find((item) => item.id === componentId);
    if (!component) return [];
    const sourceNodes = component.nodeIds
      .map((nodeId) => readNodeById(this.options.maps, nodeId))
      .filter((node): node is CanvasNode => node !== null);
    if (sourceNodes.length === 0) return [];
    const bounds = unionRects(sourceNodes);
    if (!bounds) return [];
    const viewport = this.options.store.getState().viewport;
    const size = this.options.renderer.getViewportSize();
    const centerX = (size.width / 2 - viewport.x) / viewport.zoom;
    const centerY = (size.height / 2 - viewport.y) / viewport.zoom;
    const inserted = insertNodeCopies(this.options.doc, this.options.maps, sourceNodes, {
      createdBy: this.options.user.id,
      fallbackLayerId: this.resolveActiveLayer(),
      offsetX: centerX - (bounds.x + bounds.width / 2),
      offsetY: centerY - (bounds.y + bounds.height / 2),
    });
    const ids = inserted.map((node) => node.id);
    this.setSelection(ids);
    return ids;
  }

  autoLayoutFrame(
    frameId: string,
    direction: FrameLayoutDirection,
    gap: number,
    padding: number,
    alignment: FrameLayoutAlignment,
  ): string[] {
    if (this.options.readOnly) return [];
    const changed = applyFrameAutoLayout(
      this.options.doc,
      this.options.maps,
      frameId,
      direction,
      gap,
      padding,
      alignment,
    );
    for (const nodeId of changed) this.options.renderer.refreshNodeIndex(nodeId);
    return changed;
  }

  addLayer(): CanvasLayer | null {
    if (this.options.readOnly) return null;
    const layer = addLayer(this.options.doc, this.options.maps);
    this.options.store.getState().setActiveLayerId(layer.id);
    return layer;
  }

  renameLayer(layerId: string, name: string): void {
    if (this.options.readOnly) return;
    const trimmed = name.trim();
    if (!trimmed) return;
    updateLayer(this.options.doc, this.options.maps, layerId, { name: trimmed });
  }

  moveLayer(layerId: string, direction: "up" | "down"): void {
    if (this.options.readOnly) return;
    moveLayerY(this.options.doc, this.options.maps, layerId, direction);
  }

  setLayerVisibility(layerId: string, visible: boolean): void {
    if (this.options.readOnly) return;
    setLayerVisibilityY(this.options.doc, this.options.maps, layerId, visible);
  }

  deleteLayer(layerId: string): void {
    if (this.options.readOnly) return;
    const layers = readLayers(this.options.maps);
    if (layers.length <= 1) return;
    const index = layers.findIndex((layer) => layer.id === layerId);
    if (index < 0) return;
    const fallback =
      layers.find((layer, layerIndex) => layerIndex !== index && layer.id !== layerId) ??
      layers[0];
    if (!fallback) return;
    if (deleteLayerWithFallback(this.options.doc, this.options.maps, layerId, fallback.id)) {
      this.options.store.getState().setActiveLayerId(fallback.id);
      const stillVisible = this.options.store
        .getState()
        .selectedNodeIds.filter((nodeId) => this.options.maps.nodes.has(nodeId));
      this.setSelection(stillVisible);
    }
  }

  updateSelectedFill(color: string): void {
    if (this.options.readOnly) return;
    updateNodes(this.options.doc, this.options.maps, this.selectedIds(), { fill: color });
  }

  updateSelectedStrokeWidth(width: number): void {
    if (this.options.readOnly) return;
    updateNodes(this.options.doc, this.options.maps, this.selectedIds(), {
      strokeWidth: Math.min(NODE_LIMITS.maxStroke, Math.max(NODE_LIMITS.minStroke, width)),
    });
  }

  updateSelectedFontSize(size: number): void {
    if (this.options.readOnly) return;
    updateNodes(this.options.doc, this.options.maps, this.selectedIds(), {
      fontSize: Math.min(NODE_LIMITS.maxFontSize, Math.max(NODE_LIMITS.minFontSize, size)),
    });
  }

  moveSelectionToLayer(layerId: string): void {
    if (this.options.readOnly) return;
    const ids = this.selectedIds();
    if (ids.length === 0) return;
    moveNodesToLayer(this.options.doc, this.options.maps, ids, layerId);
    this.options.store.getState().setActiveLayerId(layerId);
  }

  bringSelectionToFront(): void {
    if (this.options.readOnly) return;
    reorderNodes(this.options.doc, this.options.maps, this.selectedIds(), "front");
  }

  sendSelectionToBack(): void {
    if (this.options.readOnly) return;
    reorderNodes(this.options.doc, this.options.maps, this.selectedIds(), "back");
  }

  duplicateSelection(): void {
    if (this.options.readOnly) return;
    const selected = this.getSelectedNodes();
    if (selected.length === 0) return;
    const inserted = insertNodeCopies(this.options.doc, this.options.maps, selected, {
      createdBy: this.options.user.id,
      fallbackLayerId: this.resolveActiveLayer(),
      offsetX: 28,
      offsetY: 28,
    });
    if (inserted.length > 0) this.setSelection(inserted.map((node) => node.id));
  }

  applyText(nodeId: string, text: string): void {
    if (this.options.readOnly) return;
    const node = readNodeById(this.options.maps, nodeId);
    const fallback = node?.type === "note" ? "Sticky note" : "Text";
    updateNode(this.options.doc, this.options.maps, nodeId, {
      text: text.trim().length === 0 ? fallback : text,
    });
    this.setSelection([nodeId]);
  }

  zoomIn(): void {
    this.applyZoomFactor(1.2);
  }

  zoomOut(): void {
    this.applyZoomFactor(1 / 1.2);
  }

  resetZoom(): void {
    const viewport = this.options.store.getState().viewport;
    this.options.store.getState().setViewport(
      zoomViewportAtCenter(viewport, this.options.renderer.getViewportSize(), 1 / viewport.zoom),
    );
  }

  fitToContent(): void {
    const nodes = getOrderedVisibleNodes(this.options.maps);
    if (nodes.length === 0) {
      this.options.store.getState().setViewport({ x: 80, y: 80, zoom: 1 });
      return;
    }
    const bounds = unionRects(nodes);
    if (!bounds) return;
    const viewport = this.options.renderer.getViewportSize();
    this.options.store
      .getState()
      .setViewport(fitRectInViewport(bounds, viewport, 96));
  }

  undo(): void {
    if (this.options.readOnly) return;
    this.undoManager.undo();
    this.setSelection([]);
  }

  redo(): void {
    if (this.options.readOnly) return;
    this.undoManager.redo();
    this.setSelection([]);
  }

  /** Apply a patch to several nodes in one undoable transaction. */
  patchNodes(nodeIds: readonly string[], patch: CanvasNodePatch): void {
    if (this.options.readOnly || nodeIds.length === 0) return;
    updateNodes(this.options.doc, this.options.maps, nodeIds, patch);
    for (const nodeId of nodeIds) this.options.renderer.refreshNodeIndex(nodeId);
  }

  bringToFront(nodeIds: readonly string[]): void {
    if (this.options.readOnly || nodeIds.length === 0) return;
    reorderNodes(this.options.doc, this.options.maps, nodeIds, "front");
    this.options.renderer.markDirty("scene");
    this.options.renderer.markDirty("overlay");
  }

  sendToBack(nodeIds: readonly string[]): void {
    if (this.options.readOnly || nodeIds.length === 0) return;
    reorderNodes(this.options.doc, this.options.maps, nodeIds, "back");
    this.options.renderer.markDirty("scene");
    this.options.renderer.markDirty("overlay");
  }

  deleteSelection(): void {
    if (this.options.readOnly) return;
    const ids = this.selectedIds();
    if (ids.length === 0) return;
    this.deleteNodesWithConnectorCleanup(ids);
    this.setSelection([]);
  }

  /**
   * Delete nodes and repair connectors that pointed at them.
   *
   * A connector whose endpoint node disappears is re-anchored to the endpoint's
   * last known world position rather than deleted. Silently removing a line the
   * user drew because they deleted a box at one end is worse than leaving a
   * free-floating line they can re-attach.
   */
  private deleteNodesWithConnectorCleanup(nodeIds: readonly string[]): void {
    const doomed = new Set(nodeIds);
    const all = getOrderedVisibleNodes(this.options.maps);
    const byId = new Map(all.map((node) => [node.id, node]));

    this.options.doc.transact(() => {
      for (const node of all) {
        if (node.type !== "connector") continue;
        if (doomed.has(node.id)) continue;

        const patch: CanvasNodePatch = {};
        if (node.startNodeId && doomed.has(node.startNodeId)) {
          const anchor = byId.get(node.startNodeId);
          if (anchor) {
            patch.startX = anchor.x + anchor.width / 2;
            patch.startY = anchor.y + anchor.height / 2;
          }
          patch.startNodeId = "";
        }
        if (node.endNodeId && doomed.has(node.endNodeId)) {
          const anchor = byId.get(node.endNodeId);
          if (anchor) {
            patch.endX = anchor.x + anchor.width / 2;
            patch.endY = anchor.y + anchor.height / 2;
          }
          patch.endNodeId = "";
        }
        if (Object.keys(patch).length === 0) continue;

        const target = this.options.maps.nodes.get(node.id);
        if (!(target instanceof Y.Map)) continue;
        for (const [key, value] of Object.entries(patch)) {
          // An empty string clears the reference; the anchor coordinates keep
          // the connector visible where the deleted node used to be.
          target.set(key, value);
        }
        target.set("updatedAt", Date.now());
      }

      // Children of a deleted frame are promoted to the frame's layer rather
      // than deleted. Removing a container must not destroy its contents.
      for (const node of all) {
        if (!node.parentFrameId || !doomed.has(node.parentFrameId)) continue;
        if (doomed.has(node.id)) continue;
        const target = this.options.maps.nodes.get(node.id);
        if (!(target instanceof Y.Map)) continue;
        target.set("parentFrameId", "");
        target.set("updatedAt", Date.now());
      }

      for (const nodeId of nodeIds) this.options.maps.nodes.delete(nodeId);
    }, LOCAL_ORIGIN);

    this.options.renderer.markDirty("scene");
    this.options.renderer.markDirty("overlay");
  }

  /** Write a batch of new nodes from an AI action, in one undoable transaction. */
  insertAiNodes(
    specs: Array<{
      type: "rect" | "ellipse" | "note" | "text";
      x: number;
      y: number;
      width: number;
      height: number;
      text: string;
      fill?: string;
    }>,
  ): string[] {
    if (this.options.readOnly || specs.length === 0) return [];
    const state = this.options.store.getState();
    const theme = CANVAS_THEMES[state.theme];
    const layerId = this.resolveActiveLayer();
    const created: string[] = [];

    this.options.doc.transact(() => {
      let z = getOrderedVisibleNodes(this.options.maps).reduce(
        (max, node) => Math.max(max, node.zIndex),
        0,
      );
      for (const spec of specs) {
        z += 1;
        const node = createNode(this.options.doc, this.options.maps, {
          id: crypto.randomUUID(),
          type: spec.type,
          x: spec.x,
          y: spec.y,
          width: spec.width,
          height: spec.height,
          createdBy: this.options.user.id,
          layerId,
          text: spec.text,
          fill: spec.fill ?? (spec.type === "note" ? theme.defaultNoteFill : theme.defaultShapeFill),
          stroke: spec.type === "note" ? theme.defaultNoteStroke : theme.defaultShapeStroke,
          fontSize: spec.type === "text" ? 20 : 16,
        });
        created.push(node.id);
      }
    }, LOCAL_ORIGIN);

    this.options.renderer.markDirty("scene");
    this.options.renderer.markDirty("overlay");
    return created;
  }

  insertImageAsset(asset: AssetDto): string | null {
    if (this.options.readOnly) return null;
    const viewport = this.options.store.getState().viewport;
    const size = this.options.renderer.getViewportSize();
    const sourceRatio =
      asset.width && asset.height && asset.height > 0 ? asset.width / asset.height : 1.4;
    const maxWidth = Math.min(480, (size.width / viewport.zoom) * 0.55);
    const maxHeight = Math.min(360, (size.height / viewport.zoom) * 0.55);
    const width = Math.max(160, Math.min(maxWidth, maxHeight * sourceRatio));
    const height = Math.max(120, Math.min(maxHeight, width / sourceRatio));
    const centerX = (size.width / 2 - viewport.x) / viewport.zoom;
    const centerY = (size.height / 2 - viewport.y) / viewport.zoom;
    const node = createNode(this.options.doc, this.options.maps, {
      id: crypto.randomUUID(),
      type: "image",
      x: centerX - width / 2,
      y: centerY - height / 2,
      width,
      height,
      createdBy: this.options.user.id,
      layerId: this.resolveActiveLayer(),
      assetId: asset.id,
      aspectRatio: sourceRatio,
      fill: "#f1f5f9",
      stroke: "#cbd5e1",
      strokeWidth: 0,
    });
    this.setSelection([node.id]);
    this.options.renderer.markDirty("scene");
    this.options.renderer.markDirty("overlay");
    return node.id;
  }

  /** Move nodes to explicit positions (used by AI auto-arrange). */
  moveNodesTo(plans: ReadonlyArray<{ nodeId: string; x: number; y: number }>): void {
    if (this.options.readOnly || plans.length === 0) return;
    moveNodes(
      this.options.doc,
      this.options.maps,
      plans.map((plan) => ({ id: plan.nodeId, x: plan.x, y: plan.y })),
    );
    for (const plan of plans) this.options.renderer.refreshNodeIndex(plan.nodeId);
  }

  /** Center the viewport on a node, used by command-palette jumps. */
  jumpToNode(nodeId: string): void {
    const node = this.getNode(nodeId);
    if (!node) return;
    const viewport = this.options.store.getState().viewport;
    const size = this.options.renderer.getViewportSize();
    const rect = {
      x: node.x,
      y: node.y,
      width: Math.max(node.width, 40),
      height: Math.max(node.height, 40),
    };
    this.options.store.getState().setViewport(fitRectInViewport(rect, size, size.width * 0.3));
    this.setSelection([nodeId]);
  }

  private selectedIds(): string[] {
    return this.options.store.getState().selectedNodeIds;
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0 && event.button !== 1) return;
    const state = this.options.store.getState();
    const world = this.options.renderer.screenToWorld(event.clientX, event.clientY);
    const wantsPan = event.button === 1 || state.tool === "hand" || this.spacePressed;

    if (wantsPan) {
      this.interaction = "pan";
      this.pan = {
        startClientX: event.clientX,
        startClientY: event.clientY,
        startViewport: { ...state.viewport },
      };
      this.options.canvas.style.cursor = "grabbing";
      this.capturePointer(event.pointerId);
      event.preventDefault();
      return;
    }

    if (event.button !== 0) return;

    if (state.tool === "select") {
      if (!event.shiftKey && !this.options.readOnly && this.selectedIds().length === 1) {
        const selectedNode = this.getSelectedNodes()[0];
        if (selectedNode) {
          const tolerance = HANDLE_HIT_PX / Math.max(0.1, state.viewport.zoom);
          const handle = hitTestHandle(selectedNode, world, tolerance);
          if (handle) {
            this.interaction = "resize";
            this.resize = {
              nodeId: selectedNode.id,
              handle,
              startRect: {
                x: selectedNode.x,
                y: selectedNode.y,
                width: selectedNode.width,
                height: selectedNode.height,
              },
              pendingWorld: null,
              preserveAspect: event.shiftKey,
              frame: 0,
            };
            this.capturePointer(event.pointerId);
            this.options.canvas.style.cursor = HANDLE_CURSORS[handle];
            event.preventDefault();
            return;
          }
        }
      }

      const hit = reverseDrawOrder(getOrderedVisibleNodes(this.options.maps)).find((node) =>
        pointHitsNode(node, world),
      );

      if (!hit) {
        this.interaction = "marquee";
        this.marquee = {
          startWorld: world,
          currentWorld: world,
          baseSelection: event.shiftKey ? [...state.selectedNodeIds] : [],
        };
        if (!event.shiftKey) this.setSelection([]);
        this.options.renderer.setMarquee({ x: world.x, y: world.y, width: 0, height: 0 });
        this.capturePointer(event.pointerId);
        event.preventDefault();
        return;
      }

      if (event.shiftKey) {
        const current = new Set(state.selectedNodeIds);
        if (current.has(hit.id)) current.delete(hit.id);
        else current.add(hit.id);
        this.setSelection(Array.from(current));
        return;
      }

      const nodeIds = state.selectedNodeIds.includes(hit.id)
        ? state.selectedNodeIds
        : [hit.id];
      this.setSelection(nodeIds);
      if (this.options.readOnly) return;

      const nodes = nodeIds
        .map((nodeId) => readNodeById(this.options.maps, nodeId))
        .filter((node): node is CanvasNode => node !== null)
        .map((node) => ({ id: node.id, x: node.x, y: node.y }));
      if (nodes.length === 0) return;
      this.interaction = "drag";
      this.drag = {
        nodes,
        startWorld: world,
        pendingWorld: null,
        frame: 0,
      };
      this.capturePointer(event.pointerId);
      event.preventDefault();
      return;
    }

    if (this.options.readOnly) return;

    if (state.tool === "rect" || state.tool === "ellipse" || state.tool === "note" || state.tool === "frame") {
      const initialDraft: DraftShape = {
        type: state.tool,
        x: world.x,
        y: world.y,
        width: 0,
        height: 0,
      };
      this.interaction = "draw";
      this.draw = {
        startWorld: world,
        type: state.tool,
        draft: initialDraft,
      };
      this.options.renderer.setDraft(initialDraft);
      this.capturePointer(event.pointerId);
      event.preventDefault();
      this.setSelection([]);
      return;
    }

    if (state.tool === "path") {
      this.interaction = "path";
      this.pathDraw = { points: [world] };
      this.options.renderer.setDraftPath({ points: [world] });
      this.capturePointer(event.pointerId);
      event.preventDefault();
      this.setSelection([]);
      return;
    }

    if (state.tool === "connector") {
      // A connector starts either on a node (anchored) or in empty space
      // (free-floating, using world coordinates).
      const hit = reverseDrawOrder(getOrderedVisibleNodes(this.options.maps)).find((node) =>
        pointHitsNode(node, world, { tolerance: 6 / state.viewport.zoom }),
      );
      this.interaction = "connector";
      this.connectorDraw = {
        startWorld: world,
        startNodeId: hit?.id ?? null,
        startPort: "e",
        currentWorld: world,
      };
      this.capturePointer(event.pointerId);
      event.preventDefault();
      return;
    }

    if (state.tool === "comment") {
      // Comment placement is handled by the React comment layer, which owns the
      // popover and the API call. The controller only reports the world point.
      this.options.onCommentPlace?.(world.x, world.y);
      event.preventDefault();
      return;
    }

    if (state.tool === "text") {
      this.createTextNode(world.x, world.y);
      event.preventDefault();
    }
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    const world = this.options.renderer.screenToWorld(event.clientX, event.clientY);
    this.options.store.getState().setCursorWorld(world);
    this.queueAwarenessCursor(world);

    if (this.interaction === "pan" && this.pan) {
      const state = this.options.store.getState();
      state.setViewport({
        ...state.viewport,
        x: this.pan.startViewport.x + (event.clientX - this.pan.startClientX),
        y: this.pan.startViewport.y + (event.clientY - this.pan.startClientY),
      });
      return;
    }

    if (this.interaction === "drag" && this.drag) {
      this.drag.pendingWorld = world;
      if (this.drag.frame === 0) {
        this.drag.frame = window.requestAnimationFrame(() => this.flushDrag());
      }
      return;
    }

    if (this.interaction === "resize" && this.resize) {
      this.resize.pendingWorld = world;
      this.resize.preserveAspect = event.shiftKey;
      if (this.resize.frame === 0) {
        this.resize.frame = window.requestAnimationFrame(() => this.flushResize());
      }
      return;
    }

    if (this.interaction === "draw" && this.draw) {
      const draft = rectFromPoints(
        this.draw.startWorld,
        world,
        this.draw.type,
        event.shiftKey,
      );
      this.draw.draft = draft;
      this.options.renderer.setDraft(draft);
      return;
    }

    if (this.interaction === "path" && this.pathDraw) {
      const last = this.pathDraw.points[this.pathDraw.points.length - 1];
      // Skip sub-pixel jitter so a 4000-point cap covers real stroke length.
      if (!last || Math.hypot(world.x - last.x, world.y - last.y) > 1.5) {
        if (this.pathDraw.points.length < NODE_LIMITS.maxPoints) {
          this.pathDraw.points.push(world);
        }
        this.options.renderer.setDraftPath({ points: this.pathDraw.points });
      }
      return;
    }

    if (this.interaction === "connector" && this.connectorDraw) {
      this.connectorDraw.currentWorld = world;
      return;
    }

    if (this.interaction === "marquee" && this.marquee) {
      this.marquee.currentWorld = world;
      const rect = normalizeRect(this.marquee.startWorld, world);
      this.options.renderer.setMarquee(rect);
      return;
    }

    this.updateHoverCursor(world);
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    if (this.interaction === "drag" && this.drag) {
      this.drag.pendingWorld = this.options.renderer.screenToWorld(
        event.clientX,
        event.clientY,
      );
      this.flushDrag();
      if (this.drag.frame) window.cancelAnimationFrame(this.drag.frame);
      this.drag = null;
    }

    if (this.interaction === "resize" && this.resize) {
      this.resize.pendingWorld = this.options.renderer.screenToWorld(
        event.clientX,
        event.clientY,
      );
      this.resize.preserveAspect = event.shiftKey;
      this.flushResize();
      if (this.resize.frame) window.cancelAnimationFrame(this.resize.frame);
      this.resize = null;
    }

    if (this.interaction === "draw" && this.draw) {
      const draft = this.draw.draft;
      this.options.renderer.setDraft(null);
      if (draft) {
        this.commitDraft(draft);
      }
      this.draw = null;
    }

    if (this.interaction === "path" && this.pathDraw) {
      const points = this.pathDraw.points;
      this.options.renderer.setDraftPath(null);
      if (points.length > 1) this.commitPath(points);
      this.pathDraw = null;
    }

    if (this.interaction === "connector" && this.connectorDraw) {
      const endWorld = this.options.renderer.screenToWorld(event.clientX, event.clientY);
      const state = this.options.store.getState();
      const hit = reverseDrawOrder(getOrderedVisibleNodes(this.options.maps)).find((node) =>
        pointHitsNode(node, endWorld, { tolerance: 6 / state.viewport.zoom }),
      );
      this.commitConnector(this.connectorDraw, endWorld, hit?.id ?? null);
      this.connectorDraw = null;
    }

    if (this.interaction === "marquee" && this.marquee) {
      this.finishMarquee();
    }

    this.pan = null;
    this.interaction = "idle";
    this.options.renderer.setMarquee(null);
    this.options.canvas.style.cursor = this.baseCursor();
    if (this.options.canvas.hasPointerCapture(event.pointerId)) {
      this.options.canvas.releasePointerCapture(event.pointerId);
    }
  };

  private readonly onPointerCancel = (event: PointerEvent): void => {
    if (this.drag?.frame) window.cancelAnimationFrame(this.drag.frame);
    if (this.resize?.frame) window.cancelAnimationFrame(this.resize.frame);
    this.drag = null;
    this.resize = null;
    this.pan = null;
    this.draw = null;
    this.marquee = null;
    this.options.renderer.setDraft(null);
    this.options.renderer.setMarquee(null);
    this.interaction = "idle";
    this.options.canvas.style.cursor = this.baseCursor();
    if (this.options.canvas.hasPointerCapture(event.pointerId)) {
      this.options.canvas.releasePointerCapture(event.pointerId);
    }
  };

  private readonly onPointerLeave = (): void => {
    this.options.store.getState().setCursorWorld(null);
    this.pendingCursor = null;
    this.options.awareness.setLocalStateField("cursor", null);
    if (this.interaction === "idle") this.options.canvas.style.cursor = this.baseCursor();
  };

  private readonly onDoubleClick = (event: MouseEvent): void => {
    if (this.options.store.getState().tool !== "select") return;
    const world = this.options.renderer.screenToWorld(event.clientX, event.clientY);
    const node = reverseDrawOrder(getOrderedVisibleNodes(this.options.maps)).find(
      (candidate) => pointHitsNode(candidate, world),
    );
    if ((node?.type === "text" || node?.type === "note") && !this.options.readOnly) {
      this.setSelection([node.id]);
      this.options.onEditText(node.id, node.text);
    }
  };

  private readonly onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    const rect = this.options.canvas.getBoundingClientRect();
    const state = this.options.store.getState();
    const factor = Math.exp(-event.deltaY * 0.0015);
    state.setViewport(
      zoomViewportAt(
        state.viewport,
        { x: event.clientX - rect.left, y: event.clientY - rect.top },
        factor,
      ),
    );
  };

  private readonly onKeyUp = (event: KeyboardEvent): void => {
    if (event.code === "Space") {
      this.spacePressed = false;
      if (this.interaction !== "pan") this.options.canvas.style.cursor = this.baseCursor();
    }
  };

  private readonly onWindowBlur = (): void => {
    this.spacePressed = false;
    if (this.interaction !== "pan") this.options.canvas.style.cursor = this.baseCursor();
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (this.options.store.getState().overlayOpen) return;
    if (isEditableTarget(event.target)) return;
    const state = this.options.store.getState();
    const mod = event.metaKey || event.ctrlKey;
    const key = event.key.toLowerCase();

    if (event.code === "Space" && !isInteractiveTarget(event.target)) {
      if (!this.spacePressed) {
        this.spacePressed = true;
        this.options.canvas.style.cursor = "grab";
      }
      event.preventDefault();
      return;
    }

    if (mod && key === "z") {
      event.preventDefault();
      if (event.shiftKey) this.redo();
      else this.undo();
      return;
    }
    if (mod && key === "y") {
      event.preventDefault();
      this.redo();
      return;
    }
    if (mod && key === "c") {
      event.preventDefault();
      this.copySelection();
      return;
    }
    if (mod && key === "v") {
      event.preventDefault();
      this.pasteClipboard();
      return;
    }
    if (mod && key === "d") {
      event.preventDefault();
      this.duplicateSelection();
      return;
    }
    if (mod && key === "a") {
      event.preventDefault();
      this.setSelection(getOrderedVisibleNodes(this.options.maps).map((node) => node.id));
      return;
    }
    if (mod && key === "0") {
      event.preventDefault();
      this.resetZoom();
      return;
    }
    if (mod && (key === "+" || key === "=" || key === "add")) {
      event.preventDefault();
      this.zoomIn();
      return;
    }
    if (mod && (key === "-" || key === "subtract")) {
      event.preventDefault();
      this.zoomOut();
      return;
    }
    if (event.shiftKey && key === "1" && !mod) {
      event.preventDefault();
      this.fitToContent();
      return;
    }

    if (!mod && !event.altKey && isArrowKey(event.key)) {
      if (this.options.readOnly || state.selectedNodeIds.length === 0) return;
      if (isInteractiveTarget(event.target)) return;
      event.preventDefault();
      const distance = event.shiftKey ? 10 : 1;
      const dx = event.key === "ArrowLeft" ? -distance : event.key === "ArrowRight" ? distance : 0;
      const dy = event.key === "ArrowUp" ? -distance : event.key === "ArrowDown" ? distance : 0;
      this.nudgeSelection(dx, dy);
      return;
    }

    if (event.key === "Escape") {
      this.cancelActiveInteraction();
      return;
    }

    if ((event.key === "Delete" || event.key === "Backspace") && !state.readOnly) {
      const selected = state.selectedNodeIds;
      if (selected.length === 0) return;
      event.preventDefault();
      this.deleteSelection();
      return;
    }

    if (
      event.key === "Enter" &&
      !mod &&
      state.selectedNodeIds.length === 1 &&
      !state.readOnly &&
      !isInteractiveTarget(event.target)
    ) {
      const node = this.getSelectedNodes()[0];
      if (node?.type === "text" || node?.type === "note") {
        event.preventDefault();
        this.options.onEditText(node.id, node.text);
      }
      return;
    }

    if (!mod && !event.altKey) {
      const shortcut: Record<string, CanvasTool> = {
        v: "select",
        h: "hand",
        r: "rect",
        o: "ellipse",
        t: "text",
        n: "note",
      };
      const tool = shortcut[key];
      const navigationOnly = tool === "select" || tool === "hand";
      if (tool && (!this.options.readOnly || navigationOnly)) {
        event.preventDefault();
        state.setTool(tool);
      }
    }
  };

  private copySelection(): void {
    const selected = this.getSelectedNodes();
    if (selected.length === 0) return;
    this.copyBuffer = selected.map((node) => ({ ...node }));
    this.pasteGeneration = 0;
  }

  private pasteClipboard(): void {
    if (this.options.readOnly || this.copyBuffer.length === 0) return;
    this.pasteGeneration += 1;
    const offset = 24 * this.pasteGeneration;
    const inserted = insertNodeCopies(this.options.doc, this.options.maps, this.copyBuffer, {
      createdBy: this.options.user.id,
      fallbackLayerId: this.resolveActiveLayer(),
      offsetX: offset,
      offsetY: offset,
    });
    if (inserted.length > 0) this.setSelection(inserted.map((node) => node.id));
  }

  private nudgeSelection(dx: number, dy: number): void {
    const nodes = this.getSelectedNodes().map((node) => ({
      id: node.id,
      x: node.x + dx,
      y: node.y + dy,
    }));
    moveNodes(this.options.doc, this.options.maps, nodes);
  }

  private flushDrag(): void {
    if (!this.drag) return;
    if (this.drag.frame) {
      window.cancelAnimationFrame(this.drag.frame);
      this.drag.frame = 0;
    }
    const point = this.drag.pendingWorld;
    if (!point) return;
    this.drag.pendingWorld = null;
    const dx = point.x - this.drag.startWorld.x;
    const dy = point.y - this.drag.startWorld.y;
    moveNodes(
      this.options.doc,
      this.options.maps,
      this.drag.nodes.map((node) => ({
        id: node.id,
        x: Math.round(node.x + dx),
        y: Math.round(node.y + dy),
      })),
    );
  }

  private flushResize(): void {
    if (!this.resize) return;
    if (this.resize.frame) {
      window.cancelAnimationFrame(this.resize.frame);
      this.resize.frame = 0;
    }
    const point = this.resize.pendingWorld;
    if (!point) return;
    this.resize.pendingWorld = null;
    const rect = resizeRect(this.resize.startRect, this.resize.handle, point, {
      minSize: NODE_LIMITS.minSize,
      maxSize: NODE_LIMITS.maxSize,
      preserveAspect: this.resize.preserveAspect,
    });
    updateNode(this.options.doc, this.options.maps, this.resize.nodeId, rect);
  }

  /** Commit a freehand stroke as a path node. */
  private commitPath(points: { x: number; y: number }[]): void {
    const state = this.options.store.getState();
    const theme = CANVAS_THEMES[state.theme];
    const xs = points.map((point) => point.x);
    const ys = points.map((point) => point.y);
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    const maxX = Math.max(...xs);
    const maxY = Math.max(...ys);

    const node = createNode(this.options.doc, this.options.maps, {
      id: crypto.randomUUID(),
      type: "path",
      x: minX,
      y: minY,
      width: Math.max(NODE_LIMITS.minSize, maxX - minX),
      height: Math.max(NODE_LIMITS.minSize, maxY - minY),
      createdBy: this.options.user.id,
      layerId: this.resolveActiveLayer(),
      stroke: theme.selection,
      strokeWidth: 2,
      points,
      isClosed: false,
    });
    this.options.store.getState().setTool("select");
    this.setSelection([node.id]);
    this.options.renderer.refreshNodeIndex(node.id);
  }

  /** Commit a connector between two anchors. */
  private commitConnector(
    draw: ConnectorDrawState,
    endWorld: { x: number; y: number },
    endNodeId: string | null,
  ): void {
    const state = this.options.store.getState();
    const theme = CANVAS_THEMES[state.theme];

    // A connector with no movement is almost certainly a stray click.
    if (
      !draw.startNodeId &&
      !endNodeId &&
      Math.hypot(endWorld.x - draw.startWorld.x, endWorld.y - draw.startWorld.y) < 12
    ) {
      return;
    }

    const minX = Math.min(draw.startWorld.x, endWorld.x);
    const minY = Math.min(draw.startWorld.y, endWorld.y);

    const node = createNode(this.options.doc, this.options.maps, {
      id: crypto.randomUUID(),
      type: "connector",
      x: minX,
      y: minY,
      width: Math.max(NODE_LIMITS.minSize, Math.abs(endWorld.x - draw.startWorld.x)),
      height: Math.max(NODE_LIMITS.minSize, Math.abs(endWorld.y - draw.startWorld.y)),
      createdBy: this.options.user.id,
      layerId: this.resolveActiveLayer(),
      stroke: theme.selection,
      strokeWidth: 2,
      curveType: "curved",
      endHead: "arrow",
      startHead: "none",
      startX: draw.startWorld.x,
      startY: draw.startWorld.y,
      endX: endWorld.x,
      endY: endWorld.y,
      ...(draw.startNodeId ? { startNodeId: draw.startNodeId, startPort: draw.startPort } : {}),
      ...(endNodeId ? { endNodeId, endPort: "w" as const } : {}),
    });
    this.options.store.getState().setTool("select");
    this.setSelection([node.id]);
    this.options.renderer.refreshNodeIndex(node.id);
  }

  private commitDraft(draft: DraftShape): void {
    const state = this.options.store.getState();
    const theme = CANVAS_THEMES[state.theme];
    let width = draft.width;
    let height = draft.height;
    let x = draft.x;
    let y = draft.y;

    if (width < MIN_DRAW_SIZE || height < MIN_DRAW_SIZE) {
      if (draft.type === "note") {
        width = 220;
        height = 160;
      } else if (draft.type === "ellipse") {
        width = 160;
        height = 160;
      } else {
        width = 200;
        height = 130;
      }
      x = draft.x;
      y = draft.y;
    }

    width = clampDimension(width);
    height = clampDimension(height);
    const isNote = draft.type === "note";
    const node = createNode(this.options.doc, this.options.maps, {
      id: crypto.randomUUID(),
      type: draft.type,
      x,
      y,
      width: Math.min(NODE_LIMITS.maxSize, width),
      height: Math.min(NODE_LIMITS.maxSize, height),
      createdBy: this.options.user.id,
      layerId: this.resolveActiveLayer(),
      fill: isNote ? theme.defaultNoteFill : theme.defaultShapeFill,
      stroke: isNote ? theme.defaultNoteStroke : theme.defaultShapeStroke,
      strokeWidth: isNote ? 1 : 1,
      fontSize: isNote ? 20 : 16,
      text: "",
    });
    this.options.store.getState().setTool("select");
    this.setSelection([node.id]);
    if (isNote) this.options.onEditText(node.id, "");
  }

  private createTextNode(x: number, y: number): void {
    const node = createNode(this.options.doc, this.options.maps, {
      id: crypto.randomUUID(),
      type: "text",
      x,
      y,
      width: 280,
      height: 96,
      createdBy: this.options.user.id,
      layerId: this.resolveActiveLayer(),
      fill: "#f8fafc",
      strokeWidth: 0,
      fontSize: 24,
      text: "",
    });
    this.options.store.getState().setTool("select");
    this.setSelection([node.id]);
    this.options.onEditText(node.id, "");
  }

  private finishMarquee(): void {
    if (!this.marquee) return;
    const rect = normalizeRect(this.marquee.startWorld, this.marquee.currentWorld);
    if (rect.width >= 3 && rect.height >= 3) {
      const hits = nodesInRect(getOrderedVisibleNodes(this.options.maps), rect).map(
        (node) => node.id,
      );
      const combined = Array.from(new Set([...this.marquee.baseSelection, ...hits]));
      this.setSelection(combined);
    } else if (this.marquee.baseSelection.length > 0) {
      this.setSelection(this.marquee.baseSelection);
    }
    this.marquee = null;
    this.options.renderer.setMarquee(null);
  }

  private cancelActiveInteraction(): void {
    if (this.drag?.frame) window.cancelAnimationFrame(this.drag.frame);
    if (this.resize?.frame) window.cancelAnimationFrame(this.resize.frame);
    this.drag = null;
    this.resize = null;
    this.pan = null;
    this.draw = null;
    this.marquee = null;
    this.options.renderer.setDraft(null);
    this.options.renderer.setMarquee(null);
    this.interaction = "idle";
    this.setSelection([]);
    this.options.canvas.style.cursor = this.baseCursor();
  }

  private resolveActiveLayer(): string {
    const layers = readLayers(this.options.maps);
    const activeId = this.options.store.getState().activeLayerId;
    const active = layers.find((layer) => layer.id === activeId);
    if (active) return active.id;
    const firstVisible = layers.find((layer) => layer.visible);
    return firstVisible?.id ?? DEFAULT_LAYER_ID;
  }

  private queueAwarenessCursor(cursor: { x: number; y: number }): void {
    this.pendingCursor = cursor;
    if (this.cursorFrame !== 0) return;
    this.cursorFrame = window.requestAnimationFrame(() => {
      this.cursorFrame = 0;
      if (this.pendingCursor) {
        this.options.awareness.setLocalStateField("cursor", this.pendingCursor);
        this.pendingCursor = null;
      }
    });
  }

  private capturePointer(pointerId: number): void {
    try {
      this.options.canvas.setPointerCapture(pointerId);
    } catch {
      // Pointer capture can fail for a pointer that ended in the same frame.
    }
  }

  private applyZoomFactor(factor: number): void {
    const state = this.options.store.getState();
    state.setViewport(
      zoomViewportAtCenter(
        state.viewport,
        this.options.renderer.getViewportSize(),
        factor,
      ),
    );
  }

  private updateHoverCursor(world: { x: number; y: number }): void {
    if (this.spacePressed || this.options.readOnly) {
      this.options.canvas.style.cursor = this.baseCursor();
      return;
    }
    const state = this.options.store.getState();
    if (state.tool !== "select") {
      this.options.canvas.style.cursor = this.baseCursor();
      return;
    }
    const selected = this.getSelectedNodes();
    if (selected.length === 1) {
      const handle = hitTestHandle(
        selected[0]!,
        world,
        HANDLE_HIT_PX / Math.max(0.1, state.viewport.zoom),
      );
      if (handle) {
        this.options.canvas.style.cursor = HANDLE_CURSORS[handle];
        return;
      }
    }
    const hit = reverseDrawOrder(getOrderedVisibleNodes(this.options.maps)).find((node) =>
      pointHitsNode(node, world),
    );
    this.options.canvas.style.cursor = hit ? "move" : "default";
  }

  private baseCursor(): string {
    const state = this.options.store.getState();
    if (this.spacePressed || state.tool === "hand") return "grab";
    if (this.options.readOnly) return "default";
    if (state.tool === "text") return "text";
    if (state.tool === "select") return "default";
    return "crosshair";
  }

  private setBaseCursor(): void {
    if (this.interaction === "idle") this.options.canvas.style.cursor = this.baseCursor();
  }
}

function rectFromPoints(
  start: { x: number; y: number },
  end: { x: number; y: number },
  type: "rect" | "ellipse" | "note" | "frame",
  constrain: boolean,
): DraftShape {
  let width = Math.abs(end.x - start.x);
  let height = Math.abs(end.y - start.y);
  if (constrain) {
    const size = Math.max(width, height);
    width = size;
    height = size;
  }
  return {
    type,
    x: end.x >= start.x ? start.x : start.x - width,
    y: end.y >= start.y ? start.y : start.y - height,
    width,
    height,
  };
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select" || target.isContentEditable;
}

function isInteractiveTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(target.closest("button,a,input,textarea,select,[contenteditable='true']"));
}

function isArrowKey(key: string): boolean {
  return key === "ArrowLeft" || key === "ArrowRight" || key === "ArrowUp" || key === "ArrowDown";
}
