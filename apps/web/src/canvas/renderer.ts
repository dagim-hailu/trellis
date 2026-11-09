import type { Awareness } from "y-protocols/awareness";

import {
  isFiniteNumber,
  isValidColor,
  nodeBounds,
  type CanvasNode,
} from "@trellis/shared";

import { CANVAS_THEMES, contrastText, type CanvasTheme } from "@/lib/theme-config";
import { getAssetContentUrl } from "@/lib/api";

import {
  RESIZE_HANDLES,
  handlePoint,
  unionRects,
  type Rect,
} from "./geometry";
import { CanvasImageCache } from "./image-cache";
import { getOrderedVisibleNodes, type CanvasMaps } from "./model";
import {
  catmullRomPoints,
  connectorEndDirection,
  connectorGeometry,
  connectorStartDirection,
  resolveConnectorAnchor,
  rotatedCorners,
  type Vec2,
} from "./shapes";
import { CanvasSpatialIndex, viewportWorldRect } from "./spatial-index";
import type { CanvasUiStore, Viewport } from "./store";

export interface DraftShape {
  type: "rect" | "ellipse" | "note" | "frame";
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DraftPath {
  points: Vec2[];
}

export interface RemotePresence {
  clientId: number;
  userId: string;
  name: string;
  color: string;
  cursor: { x: number; y: number } | null;
  selection: string[];
  chatText: string | null;
  chatActiveUntil: number | null;
  followingUserId: string | null;
}

export interface SnapGuideLine {
  axis: "x" | "y";
  position: number;
  from: number;
  to: number;
  distance: number;
}

/** Which layer needs repainting. */
export type RenderLayer = "grid" | "scene" | "overlay";

const FONT_STACK = 'Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';

const CHAT_BUBBLE_MAX_WIDTH = 260;
const CHAT_BUBBLE_PADDING = 10;

/**
 * Three-layer canvas renderer.
 *
 * The viewport is a stack of three absolutely positioned canvases:
 *
 *   gridCanvas    background gradient + grid lines. Repaints only when the
 *                 viewport or theme changes.
 *   sceneCanvas   every node. Repaints when the document or viewport changes,
 *                 and draws only nodes intersecting the viewport (R-tree cull).
 *   overlayCanvas selection chrome, marquee, handles, snap guides, remote
 *                 cursors, cursor-chat bubbles and in-progress strokes.
 *
 * Splitting the layers is what makes the hot path cheap: dragging a selection
 * repaints only the overlay, and panning repaints grid + scene without touching
 * the overlay's transient state.
 */
export class CanvasRenderer {
  private readonly gridCtx: CanvasRenderingContext2D;
  private readonly sceneCtx: CanvasRenderingContext2D;
  private readonly overlayCtx: CanvasRenderingContext2D;
  private readonly storeUnsubscribe: () => void;
  private readonly nodesObserver: () => void;
  private readonly layersObserver: () => void;
  private readonly awarenessHandler: () => void;
  private readonly resizeObserver: ResizeObserver;
  private readonly spatialIndex = new CanvasSpatialIndex();
  private readonly imageCache = new CanvasImageCache();
  private readonly imageCacheUnsubscribe: () => void;
  private readonly dirty: Record<RenderLayer, boolean> = {
    grid: true,
    scene: true,
    overlay: true,
  };
  private draft: DraftShape | null = null;
  private draftPath: DraftPath | null = null;
  private marquee: Rect | null = null;
  private snapGuides: SnapGuideLine[] = [];
  private exporting = false;
  private raf = 0;
  private disposed = false;
  private lastPeerCount = -1;
  private lastViewportKey = "";
  private lastThemeKey = "";
  private indexedNodeCount = -1;

  constructor(
    private readonly canvases: {
      grid: HTMLCanvasElement;
      scene: HTMLCanvasElement;
      overlay: HTMLCanvasElement;
    },
    private readonly maps: CanvasMaps,
    private readonly awareness: Awareness,
    private readonly store: CanvasUiStore,
    private readonly localClientId: number,
    private readonly assetAccessToken: string,
  ) {
    const gridCtx = canvases.grid.getContext("2d");
    const sceneCtx = canvases.scene.getContext("2d");
    const overlayCtx = canvases.overlay.getContext("2d");
    if (!gridCtx || !sceneCtx || !overlayCtx) {
      throw new Error("This browser does not support the Canvas 2D API");
    }
    this.gridCtx = gridCtx;
    this.sceneCtx = sceneCtx;
    this.overlayCtx = overlayCtx;

    this.nodesObserver = () => {
      this.markDirty("scene");
      this.markDirty("overlay");
    };
    this.layersObserver = () => {
      this.markDirty("scene");
      this.markDirty("overlay");
    };
    this.awarenessHandler = () => {
      this.updatePeerCount();
      this.markDirty("overlay");
    };
    this.storeUnsubscribe = store.subscribe(() => {
      const state = store.getState();
      const viewportKey = `${state.viewport.x}:${state.viewport.y}:${state.viewport.zoom}`;
      const themeKey = state.theme;
      if (viewportKey !== this.lastViewportKey) {
        this.lastViewportKey = viewportKey;
        this.markDirty("grid");
        this.markDirty("scene");
        this.markDirty("overlay");
      }
      if (themeKey !== this.lastThemeKey) {
        this.lastThemeKey = themeKey;
        this.markDirty("grid");
        this.markDirty("scene");
        this.markDirty("overlay");
      }
      this.markDirty("overlay");
    });
    this.imageCacheUnsubscribe = this.imageCache.subscribe(() => {
      this.markDirty("scene");
    });

    this.maps.nodes.observeDeep(this.nodesObserver);
    this.maps.layers.observeDeep(this.layersObserver);
    this.awareness.on("change", this.awarenessHandler);
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvases.scene.parentElement ?? canvases.scene);

    this.updatePeerCount();
    this.resize();
    this.start();
  }

  start(): void {
    if (this.disposed) return;
    this.markDirty("grid");
    this.markDirty("scene");
    this.markDirty("overlay");
  }

  setDraft(draft: DraftShape | null): void {
    this.draft = draft;
    this.markDirty("overlay");
  }

  setDraftPath(path: DraftPath | null): void {
    this.draftPath = path;
    this.markDirty("overlay");
  }

  setMarquee(marquee: Rect | null): void {
    this.marquee = marquee;
    this.markDirty("overlay");
  }

  setSnapGuides(guides: SnapGuideLine[]): void {
    this.snapGuides = guides;
    this.markDirty("overlay");
  }

  getViewport(): Viewport {
    return this.store.getState().viewport;
  }

  getViewportSize(): { width: number; height: number } {
    return { width: this.canvases.scene.clientWidth, height: this.canvases.scene.clientHeight };
  }

  screenToWorld(clientX: number, clientY: number): { x: number; y: number } {
    const rect = this.canvases.scene.getBoundingClientRect();
    const { x, y, zoom } = this.store.getState().viewport;
    return {
      x: (clientX - rect.left - x) / zoom,
      y: (clientY - rect.top - y) / zoom,
    };
  }

  worldToScreen(worldX: number, worldY: number): { x: number; y: number } {
    const { x, y, zoom } = this.store.getState().viewport;
    return { x: worldX * zoom + x, y: worldY * zoom + y };
  }

  /** Node ids currently intersecting the viewport. Exposed for tests. */
  visibleNodeIds(): string[] {
    const state = this.store.getState();
    this.ensureIndex();
    return this.spatialIndex.search(
      viewportWorldRect(state.viewport, this.getViewportSize()),
    );
  }

  async exportPng(): Promise<Blob | null> {
    this.exporting = true;
    try {
      this.drawScene(true);
      await this.imageCache.waitForIdle();
      this.drawScene(true);
      return await new Promise<Blob | null>((resolve) => {
        this.canvases.scene.toBlob((blob) => resolve(blob), "image/png");
      });
    } finally {
      this.exporting = false;
      this.markDirty("scene");
      this.markDirty("overlay");
    }
  }

  resize(): void {
    if (this.disposed) return;
    const rect = this.canvases.scene.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(rect.width * dpr));
    const height = Math.max(1, Math.round(rect.height * dpr));

    for (const canvas of [this.canvases.grid, this.canvases.scene, this.canvases.overlay]) {
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
    }
    this.markDirty("grid");
    this.markDirty("scene");
    this.markDirty("overlay");
  }

  markDirty(layer: RenderLayer): void {
    this.dirty[layer] = true;
    this.scheduleDraw();
  }

  scheduleDraw(): void {
    if (this.disposed || this.raf !== 0) return;
    this.raf = window.requestAnimationFrame(() => {
      this.raf = 0;
      this.draw();
    });
  }

  destroy(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.raf) window.cancelAnimationFrame(this.raf);
    this.resizeObserver.disconnect();
    this.storeUnsubscribe();
    this.imageCacheUnsubscribe();
    this.maps.nodes.unobserveDeep(this.nodesObserver);
    this.maps.layers.unobserveDeep(this.layersObserver);
    this.awareness.off("change", this.awarenessHandler);
    this.imageCache.clear();
  }

  private draw(): void {
    if (this.dirty.grid) {
      this.drawGrid();
      this.dirty.grid = false;
    }
    if (this.dirty.scene) {
      this.drawScene(false);
      this.dirty.scene = false;
    }
    if (this.dirty.overlay) {
      this.drawOverlay();
      this.dirty.overlay = false;
    }
  }

  /**
   * Rebuild the R-tree when the node count changes.
   *
   * A full rebuild is O(n log n) and only runs when nodes are added or removed.
   * Moves and resizes during a drag go through the controller's incremental
   * `upsert`, so the common hot path never rebuilds.
   */
  private ensureIndex(): void {
    let count = 0;
    this.maps.nodes.forEach(() => {
      count += 1;
    });
    if (count === this.indexedNodeCount) return;
    this.indexedNodeCount = count;
    this.spatialIndex.rebuild(getOrderedVisibleNodes(this.maps));
  }

  /** Update one node's index entry after a move or resize. */
  refreshNodeIndex(nodeId: string): void {
    const nodes = getOrderedVisibleNodes(this.maps);
    const node = nodes.find((candidate) => candidate.id === nodeId);
    if (!node) {
      this.spatialIndex.remove(nodeId);
      return;
    }
    this.spatialIndex.upsert(node);
    this.markDirty("scene");
    this.markDirty("overlay");
  }

  private drawGrid(): void {
    const canvas = this.canvases.grid;
    const ctx = this.gridCtx;
    const dpr = window.devicePixelRatio || 1;
    const displayWidth = canvas.width / dpr;
    const displayHeight = canvas.height / dpr;
    const state = this.store.getState();
    const viewport = state.viewport;
    const theme = CANVAS_THEMES[state.theme];

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, displayWidth, displayHeight);

    // Background: a soft radial wash over the flat theme colour, which is what
    // gives the glass panels something to refract.
    ctx.fillStyle = theme.background;
    ctx.fillRect(0, 0, displayWidth, displayHeight);
    const glow = ctx.createRadialGradient(
      displayWidth * 0.5,
      displayHeight * 0.15,
      0,
      displayWidth * 0.5,
      displayHeight * 0.15,
      Math.max(displayWidth, displayHeight) * 0.9,
    );
    glow.addColorStop(0, theme.gridGlow ?? "rgba(99,102,241,0.10)");
    glow.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, displayWidth, displayHeight);

    let step = 40;
    while (step * viewport.zoom < 22) step *= 2;
    while (step * viewport.zoom > 90) step /= 2;

    const left = (-viewport.x) / viewport.zoom;
    const top = (-viewport.y) / viewport.zoom;
    const right = (displayWidth - viewport.x) / viewport.zoom;
    const bottom = (displayHeight - viewport.y) / viewport.zoom;

    const startX = Math.floor(left / step) * step;
    const startY = Math.floor(top / step) * step;

    ctx.strokeStyle = theme.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = startX; x <= right; x += step) {
      const screenX = x * viewport.zoom + viewport.x;
      ctx.moveTo(screenX, 0);
      ctx.lineTo(screenX, displayHeight);
    }
    for (let y = startY; y <= bottom; y += step) {
      const screenY = y * viewport.zoom + viewport.y;
      ctx.moveTo(0, screenY);
      ctx.lineTo(displayWidth, screenY);
    }
    ctx.stroke();
  }

  private drawScene(exporting: boolean): void {
    const canvas = this.canvases.scene;
    const ctx = this.sceneCtx;
    const dpr = window.devicePixelRatio || 1;
    const displayWidth = canvas.width / dpr;
    const displayHeight = canvas.height / dpr;
    const state = this.store.getState();
    const viewport = state.viewport;
    const theme = CANVAS_THEMES[state.theme];

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, displayWidth, displayHeight);

    ctx.save();
    ctx.translate(viewport.x, viewport.y);
    ctx.scale(viewport.zoom, viewport.zoom);

    const allNodes = getOrderedVisibleNodes(this.maps);
    const nodes = exporting ? allNodes : this.cullToViewport(allNodes, viewport);
    const byId = new Map(allNodes.map((node) => [node.id, node]));

    // Frames paint first so their children can be clipped to them, then
    // everything else in draw order.
    const frames = nodes.filter((node) => node.type === "frame");
    const others = nodes.filter((node) => node.type !== "frame");

    for (const frame of frames) {
      this.drawFrame(ctx, frame, byId, nodes, viewport.zoom, theme);
    }
    for (const node of others) {
      this.drawNode(ctx, node, byId, viewport.zoom, theme);
    }

    ctx.restore();

    if (allNodes.length === 0 && !exporting) {
      ctx.fillStyle = theme.emptyHint;
      ctx.font = `500 15px ${FONT_STACK}`;
      ctx.textAlign = "center";
      ctx.fillText(
        "Draw a shape, add a sticky note, or press ? for shortcuts",
        displayWidth / 2,
        displayHeight / 2,
      );
      ctx.textAlign = "left";
    }
  }

  /**
   * Cull to the viewport using the R-tree.
   *
   * Frames are always kept: a frame's children are clipped to it, and dropping
   * a frame while keeping its children would render them unclipped. Frames are
   * cheap and few, so this is the correct trade.
   */
  private cullToViewport(nodes: CanvasNode[], viewport: Viewport): CanvasNode[] {
    this.ensureIndex();
    const rect = viewportWorldRect(viewport, this.getViewportSize());
    const visible = new Set(this.spatialIndex.search(rect));
    const result: CanvasNode[] = [];
    for (const node of nodes) {
      if (node.type === "frame" || visible.has(node.id)) result.push(node);
    }
    return result;
  }

  private drawOverlay(): void {
    const canvas = this.canvases.overlay;
    const ctx = this.overlayCtx;
    const dpr = window.devicePixelRatio || 1;
    const displayWidth = canvas.width / dpr;
    const displayHeight = canvas.height / dpr;
    const state = this.store.getState();
    const viewport = state.viewport;
    const theme = CANVAS_THEMES[state.theme];

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, displayWidth, displayHeight);

    if (this.exporting) return;

    const allNodes = getOrderedVisibleNodes(this.maps);
    const nodes = this.cullToViewport(allNodes, viewport);
    const presence = this.readPresence();

    ctx.save();
    ctx.translate(viewport.x, viewport.y);
    ctx.scale(viewport.zoom, viewport.zoom);

    this.drawRemoteSelections(ctx, nodes, presence, viewport.zoom);
    this.drawSelection(ctx, allNodes, viewport.zoom, theme);
    this.drawSnapGuides(ctx, viewport.zoom, theme);

    if (this.draft && this.draft.width > 0 && this.draft.height > 0) {
      this.drawDraft(ctx, this.draft, viewport.zoom, theme);
    }
    if (this.draftPath && this.draftPath.points.length > 1) {
      this.drawDraftPath(ctx, this.draftPath, viewport.zoom, theme);
    }
    if (this.marquee) {
      this.drawMarquee(ctx, this.marquee, viewport.zoom, theme);
    }

    ctx.restore();

    this.drawPresenceCursors(ctx, presence, viewport, theme);
  }

  private drawNode(
    ctx: CanvasRenderingContext2D,
    node: CanvasNode,
    byId: Map<string, CanvasNode>,
    zoom: number,
    theme: CanvasTheme,
  ): void {
    const opacity = node.opacity ?? 1;
    if (opacity <= 0) return;

    ctx.save();
    ctx.globalAlpha = opacity;

    // Rotation is applied about the node centre, so every renderer below can
    // keep working in unrotated local coordinates.
    const rotation = node.rotation ?? 0;
    if (rotation !== 0) {
      const bounds = nodeBounds(node);
      const centreX = (bounds.left + bounds.right) / 2;
      const centreY = (bounds.top + bounds.bottom) / 2;
      ctx.translate(centreX, centreY);
      ctx.rotate(rotation);
      ctx.translate(-centreX, -centreY);
    }

    switch (node.type) {
      case "ellipse":
        this.drawEllipse(ctx, node, theme);
        break;
      case "rect":
        this.drawRect(ctx, node, theme);
        break;
      case "note":
        this.drawNote(ctx, node, theme, zoom);
        break;
      case "text":
        this.drawTextBlock(ctx, node, theme);
        break;
      case "path":
        this.drawPath(ctx, node);
        break;
      case "image":
        this.drawImage(ctx, node, theme);
        break;
      case "connector":
        this.drawConnector(ctx, node, byId, theme);
        break;
      case "frame":
        // Frames are drawn in the frame pass.
        break;
    }

    ctx.restore();
  }

  private drawEllipse(ctx: CanvasRenderingContext2D, node: CanvasNode, theme: CanvasTheme): void {
    ctx.beginPath();
    ctx.ellipse(
      node.x + node.width / 2,
      node.y + node.height / 2,
      Math.abs(node.width) / 2,
      Math.abs(node.height) / 2,
      0,
      0,
      Math.PI * 2,
    );
    ctx.fillStyle = node.fill;
    ctx.globalAlpha = (node.opacity ?? 1) * 0.92;
    ctx.fill();
    ctx.globalAlpha = node.opacity ?? 1;
    if (node.strokeWidth > 0) {
      ctx.strokeStyle = node.stroke;
      ctx.lineWidth = node.strokeWidth;
      ctx.stroke();
    }
    if (node.text) {
      this.drawCenteredText(ctx, node, theme);
    }
  }

  private drawRect(ctx: CanvasRenderingContext2D, node: CanvasNode, theme: CanvasTheme): void {
    roundedRectPath(ctx, node.x, node.y, node.width, node.height, 12);
    ctx.fillStyle = node.fill;
    ctx.globalAlpha = (node.opacity ?? 1) * 0.92;
    ctx.fill();
    ctx.globalAlpha = node.opacity ?? 1;
    if (node.strokeWidth > 0) {
      ctx.strokeStyle = node.stroke;
      ctx.lineWidth = node.strokeWidth;
      ctx.stroke();
    }
    if (node.text) {
      this.drawCenteredText(ctx, node, theme);
    }
  }

  private drawNote(
    ctx: CanvasRenderingContext2D,
    node: CanvasNode,
    theme: CanvasTheme,
    zoom: number,
  ): void {
    ctx.shadowColor = theme.noteShadow;
    ctx.shadowBlur = 18 / Math.max(0.5, zoom);
    ctx.shadowOffsetY = 7 / Math.max(0.5, zoom);
    roundedRectPath(ctx, node.x, node.y, node.width, node.height, 9);
    ctx.fillStyle = node.fill;
    ctx.fill();
    ctx.shadowColor = "transparent";
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
    ctx.strokeStyle = node.stroke;
    ctx.lineWidth = Math.max(0.75, node.strokeWidth || 1);
    ctx.stroke();
    ctx.fillStyle = "rgba(15, 23, 42, 0.07)";
    roundedRectPath(ctx, node.x + 1, node.y + 1, node.width - 2, 5, 4);
    ctx.fill();
    this.drawNoteText(ctx, node);
  }

  private drawTextBlock(
    ctx: CanvasRenderingContext2D,
    node: CanvasNode,
    theme: CanvasTheme,
  ): void {
    ctx.fillStyle = theme.textBlockFill;
    roundedRectPath(ctx, node.x, node.y, node.width, node.height, 10);
    ctx.fill();
    this.drawText(ctx, node, theme);
  }

  /** Freehand stroke, smoothed with a Catmull-Rom spline. */
  private drawPath(ctx: CanvasRenderingContext2D, node: CanvasNode): void {
    const points = node.points ?? [];
    if (points.length === 0) return;
    const smoothed = catmullRomPoints(points, { isClosed: node.isClosed ?? false });
    if (smoothed.length === 0) return;

    ctx.beginPath();
    const first = smoothed[0]!;
    ctx.moveTo(first.x, first.y);
    for (let index = 1; index < smoothed.length; index += 1) {
      const point = smoothed[index]!;
      ctx.lineTo(point.x, point.y);
    }
    if (node.isClosed) ctx.closePath();

    ctx.strokeStyle = node.stroke;
    ctx.lineWidth = Math.max(0.5, node.strokeWidth);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.stroke();
  }

  /** Image node with an aspect-preserving fit and a shimmer while loading. */
  private drawImage(
    ctx: CanvasRenderingContext2D,
    node: CanvasNode,
    theme: CanvasTheme,
  ): void {
    const url = node.url ?? (node.assetId ? getAssetContentUrl(node.assetId) : null);
    const key = node.assetId ?? node.url ?? node.id;

    roundedRectPath(ctx, node.x, node.y, node.width, node.height, 10);
    ctx.save();
    ctx.clip();

    if (!url) {
      ctx.fillStyle = theme.imagePlaceholder;
      ctx.fillRect(node.x, node.y, node.width, node.height);
      ctx.restore();
      return;
    }

    const entry = this.imageCache.get(key, url, node.assetId ? this.assetAccessToken : undefined);
    if (entry.status === "ready" && entry.image) {
      const image = entry.image;
      const sourceRatio =
        node.aspectRatio ??
        (image.naturalHeight > 0 ? image.naturalWidth / image.naturalHeight : 1);
      const boxRatio = node.height === 0 ? 1 : node.width / node.height;
      let drawWidth = node.width;
      let drawHeight = node.height;
      if (sourceRatio > boxRatio) {
        drawHeight = node.width / sourceRatio;
      } else {
        drawWidth = node.height * sourceRatio;
      }
      const offsetX = node.x + (node.width - drawWidth) / 2;
      const offsetY = node.y + (node.height - drawHeight) / 2;
      ctx.drawImage(image, offsetX, offsetY, drawWidth, drawHeight);
    } else if (entry.status === "error") {
      ctx.fillStyle = theme.imagePlaceholder;
      ctx.fillRect(node.x, node.y, node.width, node.height);
      ctx.fillStyle = theme.emptyHint;
      ctx.font = `500 12px ${FONT_STACK}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("Image unavailable", node.x + node.width / 2, node.y + node.height / 2);
      ctx.textAlign = "left";
      ctx.textBaseline = "alphabetic";
    } else {
      // Loading: a diagonal shimmer band over the placeholder.
      ctx.fillStyle = theme.imagePlaceholder;
      ctx.fillRect(node.x, node.y, node.width, node.height);
      const shimmer = ctx.createLinearGradient(
        node.x,
        node.y,
        node.x + node.width,
        node.y + node.height,
      );
      shimmer.addColorStop(0, "rgba(255,255,255,0)");
      shimmer.addColorStop(0.5, "rgba(255,255,255,0.10)");
      shimmer.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = shimmer;
      ctx.fillRect(node.x, node.y, node.width, node.height);
    }

    ctx.restore();

    if (node.strokeWidth > 0) {
      roundedRectPath(ctx, node.x, node.y, node.width, node.height, 10);
      ctx.strokeStyle = node.stroke;
      ctx.lineWidth = node.strokeWidth;
      ctx.stroke();
    }
  }

  /** Connector: straight, curved or orthogonal, with optional terminal heads. */
  private drawConnector(
    ctx: CanvasRenderingContext2D,
    node: CanvasNode,
    byId: Map<string, CanvasNode>,
    theme: CanvasTheme,
  ): void {
    const lookup = (nodeId: string): CanvasNode | null => byId.get(nodeId) ?? null;
    const start = resolveConnectorAnchor(node, "start", lookup);
    const end = resolveConnectorAnchor(node, "end", lookup);
    if (!start || !end) return;

    const geometry = connectorGeometry(start, end, node.curveType ?? "straight");

    ctx.beginPath();
    if (geometry.orthogonal) {
      const first = geometry.orthogonal[0]!;
      ctx.moveTo(first.x, first.y);
      for (let index = 1; index < geometry.orthogonal.length; index += 1) {
        const point = geometry.orthogonal[index]!;
        ctx.lineTo(point.x, point.y);
      }
    } else if (geometry.control) {
      ctx.moveTo(start.x, start.y);
      ctx.bezierCurveTo(
        geometry.control.c1.x,
        geometry.control.c1.y,
        geometry.control.c2.x,
        geometry.control.c2.y,
        end.x,
        end.y,
      );
    } else {
      ctx.moveTo(start.x, start.y);
      ctx.lineTo(end.x, end.y);
    }

    ctx.strokeStyle = node.stroke;
    ctx.lineWidth = Math.max(0.5, node.strokeWidth);
    ctx.lineCap = "round";
    ctx.stroke();

    const headColor = isValidColor(node.stroke) ? node.stroke : theme.selection;
    this.drawConnectorHead(
      ctx,
      end,
      connectorEndDirection(geometry),
      node.endHead ?? "arrow",
      Math.max(6, node.strokeWidth * 4),
      headColor,
    );
    this.drawConnectorHead(
      ctx,
      start,
      connectorStartDirection(geometry),
      node.startHead ?? "none",
      Math.max(6, node.strokeWidth * 4),
      headColor,
    );
  }

  private drawConnectorHead(
    ctx: CanvasRenderingContext2D,
    point: Vec2,
    direction: Vec2,
    head: string,
    size: number,
    color: string,
  ): void {
    if (head === "none") return;
    ctx.save();
    ctx.fillStyle = color;
    ctx.strokeStyle = color;

    if (head === "arrow") {
      const perpendicular = { x: -direction.y, y: direction.x };
      ctx.beginPath();
      ctx.moveTo(point.x, point.y);
      ctx.lineTo(
        point.x - direction.x * size + perpendicular.x * size * 0.45,
        point.y - direction.y * size + perpendicular.y * size * 0.45,
      );
      ctx.lineTo(
        point.x - direction.x * size - perpendicular.x * size * 0.45,
        point.y - direction.y * size - perpendicular.y * size * 0.45,
      );
      ctx.closePath();
      ctx.fill();
    } else if (head === "circle") {
      ctx.beginPath();
      ctx.arc(point.x, point.y, size * 0.35, 0, Math.PI * 2);
      ctx.fill();
    } else if (head === "bar") {
      const perpendicular = { x: -direction.y, y: direction.x };
      ctx.lineWidth = Math.max(1.5, size * 0.22);
      ctx.beginPath();
      ctx.moveTo(point.x + perpendicular.x * size * 0.5, point.y + perpendicular.y * size * 0.5);
      ctx.lineTo(point.x - perpendicular.x * size * 0.5, point.y - perpendicular.y * size * 0.5);
      ctx.stroke();
    }

    ctx.restore();
  }

  /**
   * Frame: container body, title tag, and clipped children.
   *
   * Children are identified by `parentFrameId`. They are drawn here, inside the
   * clip, and skipped by the main node pass so they are never painted twice.
   */
  private drawFrame(
    ctx: CanvasRenderingContext2D,
    frame: CanvasNode,
    byId: Map<string, CanvasNode>,
    visibleNodes: readonly CanvasNode[],
    zoom: number,
    theme: CanvasTheme,
  ): void {
    ctx.save();
    ctx.globalAlpha = frame.opacity ?? 1;

    roundedRectPath(ctx, frame.x, frame.y, frame.width, frame.height, 14);
    ctx.fillStyle = frame.fill;
    ctx.fill();
    ctx.strokeStyle = frame.stroke;
    ctx.lineWidth = Math.max(0.75, frame.strokeWidth);
    ctx.stroke();

    // Title tag above the frame, drawn at a constant screen size so it stays
    // legible when zoomed out.
    const titleSize = Math.max(10, 13 / Math.max(0.4, zoom));
    ctx.fillStyle = theme.text;
    ctx.font = `600 ${titleSize}px ${FONT_STACK}`;
    ctx.textBaseline = "bottom";
    ctx.fillText(frame.text || "Frame", frame.x + 4, frame.y - 8 / Math.max(0.4, zoom));
    ctx.textBaseline = "alphabetic";

    if (frame.clipContent !== false) {
      ctx.beginPath();
      roundedRectPath(ctx, frame.x, frame.y, frame.width, frame.height, 14);
      ctx.clip();
    }

    for (const child of visibleNodes) {
      if (child.parentFrameId !== frame.id) continue;
      this.drawNode(ctx, child, byId, zoom, theme);
    }

    ctx.restore();
  }

  private drawCenteredText(
    ctx: CanvasRenderingContext2D,
    node: CanvasNode,
    theme: CanvasTheme,
  ): void {
    const fontSize = node.fontSize;
    ctx.save();
    roundedRectPath(ctx, node.x, node.y, node.width, node.height, 10);
    ctx.clip();
    ctx.fillStyle = contrastText(node.fill) || theme.text;
    ctx.font = `600 ${fontSize}px ${FONT_STACK}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const lines = wrapLines(ctx, node.text, Math.max(24, node.width - 24));
    const lineHeight = fontSize * 1.3;
    const totalHeight = lines.length * lineHeight;
    let y = node.y + node.height / 2 - totalHeight / 2 + lineHeight / 2;
    for (const line of lines) {
      if (y > node.y + node.height) break;
      ctx.fillText(line, node.x + node.width / 2, y);
      y += lineHeight;
    }
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    ctx.restore();
  }

  private drawText(
    ctx: CanvasRenderingContext2D,
    node: CanvasNode,
    theme: CanvasTheme,
  ): void {
    const fontSize = node.fontSize;
    const padding = 12;
    const lineHeight = fontSize * 1.35;
    ctx.save();
    roundedRectPath(
      ctx,
      node.x + 1,
      node.y + 1,
      Math.max(0, node.width - 2),
      Math.max(0, node.height - 2),
      9,
    );
    ctx.clip();
    ctx.fillStyle = theme.text;
    ctx.font = `500 ${fontSize}px ${FONT_STACK}`;
    ctx.textBaseline = "top";

    const lines = wrapLines(ctx, node.text || "Text", Math.max(24, node.width - padding * 2));
    let y = node.y + padding;
    for (const line of lines) {
      if (y + lineHeight > node.y + node.height - padding / 2) break;
      ctx.fillText(line, node.x + padding, y);
      y += lineHeight;
    }
    ctx.restore();
  }

  private drawNoteText(ctx: CanvasRenderingContext2D, node: CanvasNode): void {
    const fontSize = node.fontSize;
    const padding = 18;
    const lineHeight = fontSize * 1.35;
    ctx.save();
    roundedRectPath(ctx, node.x, node.y, node.width, node.height, 9);
    ctx.clip();
    ctx.fillStyle = contrastText(node.fill);
    ctx.font = `600 ${fontSize}px ${FONT_STACK}`;
    ctx.textBaseline = "top";
    const lines = wrapLines(
      ctx,
      node.text || "Sticky note",
      Math.max(28, node.width - padding * 2),
    );
    const totalHeight = Math.min(node.height - padding * 2, lines.length * lineHeight);
    let y = node.y + Math.max(padding, (node.height - totalHeight) / 2);
    for (const line of lines) {
      if (y + lineHeight > node.y + node.height - padding / 2) break;
      ctx.fillText(line, node.x + padding, y);
      y += lineHeight;
    }
    ctx.restore();
  }

  private drawDraft(
    ctx: CanvasRenderingContext2D,
    draft: DraftShape,
    zoom: number,
    theme: CanvasTheme,
  ): void {
    ctx.save();
    ctx.fillStyle =
      draft.type === "note" ? `${theme.defaultNoteFill}33` : theme.selectionFill;
    ctx.strokeStyle = theme.selection;
    ctx.lineWidth = 1.5 / zoom;
    ctx.setLineDash([8 / zoom, 4 / zoom]);
    if (draft.type === "ellipse") {
      ctx.beginPath();
      ctx.ellipse(
        draft.x + draft.width / 2,
        draft.y + draft.height / 2,
        Math.abs(draft.width) / 2,
        Math.abs(draft.height) / 2,
        0,
        0,
        Math.PI * 2,
      );
      ctx.fill();
      ctx.stroke();
    } else {
      roundedRectPath(ctx, draft.x, draft.y, draft.width, draft.height, draft.type === "note" ? 9 : 12);
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawDraftPath(
    ctx: CanvasRenderingContext2D,
    draft: DraftPath,
    zoom: number,
    theme: CanvasTheme,
  ): void {
    const smoothed = catmullRomPoints(draft.points, { isClosed: false });
    if (smoothed.length < 2) return;
    ctx.save();
    ctx.beginPath();
    const first = smoothed[0]!;
    ctx.moveTo(first.x, first.y);
    for (let index = 1; index < smoothed.length; index += 1) {
      const point = smoothed[index]!;
      ctx.lineTo(point.x, point.y);
    }
    ctx.strokeStyle = theme.selection;
    ctx.lineWidth = 2 / zoom;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.stroke();
    ctx.restore();
  }

  private drawMarquee(
    ctx: CanvasRenderingContext2D,
    marquee: Rect,
    zoom: number,
    theme: CanvasTheme,
  ): void {
    ctx.save();
    ctx.fillStyle = theme.marqueeFill;
    ctx.strokeStyle = theme.marqueeStroke;
    ctx.lineWidth = 1 / zoom;
    ctx.setLineDash([5 / zoom, 3 / zoom]);
    ctx.fillRect(marquee.x, marquee.y, marquee.width, marquee.height);
    ctx.strokeRect(marquee.x, marquee.y, marquee.width, marquee.height);
    ctx.restore();
  }

  private drawSnapGuides(
    ctx: CanvasRenderingContext2D,
    zoom: number,
    theme: CanvasTheme,
  ): void {
    if (this.snapGuides.length === 0) return;
    ctx.save();
    ctx.strokeStyle = theme.snapGuide;
    ctx.lineWidth = 1 / zoom;
    ctx.setLineDash([4 / zoom, 4 / zoom]);
    for (const guide of this.snapGuides) {
      ctx.beginPath();
      if (guide.axis === "x") {
        ctx.moveTo(guide.position, guide.from);
        ctx.lineTo(guide.position, guide.to);
      } else {
        ctx.moveTo(guide.from, guide.position);
        ctx.lineTo(guide.to, guide.position);
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawSelection(
    ctx: CanvasRenderingContext2D,
    nodes: CanvasNode[],
    zoom: number,
    theme: CanvasTheme,
  ): void {
    const selectedIds = this.store.getState().selectedNodeIds;
    if (selectedIds.length === 0) return;
    const selected = new Set(selectedIds);
    const selectedNodes = nodes.filter((node) => selected.has(node.id));
    if (selectedNodes.length === 0) return;

    ctx.save();
    ctx.strokeStyle = theme.selection;
    ctx.lineWidth = 1.5 / zoom;
    ctx.setLineDash([5 / zoom, 3 / zoom]);
    for (const node of selectedNodes) {
      if (node.type === "connector") {
        const bounds = nodeBounds(node);
        ctx.strokeRect(bounds.left - 2, bounds.top - 2, bounds.right - bounds.left + 4, bounds.bottom - bounds.top + 4);
        continue;
      }
      // Rotated nodes get a rotated outline so the chrome follows the shape.
      if ((node.rotation ?? 0) !== 0) {
        const corners = rotatedCorners(node);
        ctx.beginPath();
        const first = corners[0]!;
        ctx.moveTo(first.x, first.y);
        for (let index = 1; index < corners.length; index += 1) {
          const corner = corners[index]!;
          ctx.lineTo(corner.x, corner.y);
        }
        ctx.closePath();
        ctx.stroke();
        continue;
      }
      roundedRectPath(ctx, node.x - 2, node.y - 2, node.width + 4, node.height + 4, 10);
      ctx.stroke();
    }
    ctx.setLineDash([]);

    if (selectedNodes.length === 1) {
      const node = selectedNodes[0]!;
      // Handles stay axis-aligned in this pass. Rotated resize is a follow-up:
      // doing both at once makes the geometry module unmaintainable.
      const rect: Rect = { x: node.x, y: node.y, width: node.width, height: node.height };
      const handleSize = 8 / zoom;
      for (const handle of RESIZE_HANDLES) {
        const point = handlePoint(rect, handle);
        ctx.fillStyle = theme.handleFill;
        ctx.strokeStyle = theme.handleStroke;
        ctx.lineWidth = 1.5 / zoom;
        ctx.fillRect(
          point.x - handleSize / 2,
          point.y - handleSize / 2,
          handleSize,
          handleSize,
        );
        ctx.strokeRect(
          point.x - handleSize / 2,
          point.y - handleSize / 2,
          handleSize,
          handleSize,
        );
      }
    } else {
      const bounds = unionRects(selectedNodes);
      if (bounds) {
        ctx.strokeStyle = theme.selection;
        ctx.globalAlpha = 0.45;
        ctx.lineWidth = 1 / zoom;
        ctx.strokeRect(bounds.x - 6, bounds.y - 6, bounds.width + 12, bounds.height + 12);
        ctx.globalAlpha = 1;
      }
    }
    ctx.restore();
  }

  private drawRemoteSelections(
    ctx: CanvasRenderingContext2D,
    nodes: CanvasNode[],
    presence: RemotePresence[],
    zoom: number,
  ): void {
    if (presence.length === 0) return;
    const byId = new Map(nodes.map((node) => [node.id, node]));
    for (const remote of presence) {
      for (const nodeId of remote.selection.slice(0, 25)) {
        const node = byId.get(nodeId);
        if (!node) continue;
        ctx.save();
        ctx.strokeStyle = remote.color;
        ctx.lineWidth = 1.5 / zoom;
        ctx.setLineDash([4 / zoom, 4 / zoom]);
        roundedRectPath(ctx, node.x - 3, node.y - 3, node.width + 6, node.height + 6, 10);
        ctx.stroke();
        ctx.restore();
      }
    }
  }

  private drawPresenceCursors(
    ctx: CanvasRenderingContext2D,
    presence: RemotePresence[],
    viewport: Viewport,
    theme: CanvasTheme,
  ): void {
    const now = Date.now();
    for (const remote of presence.slice(0, 100)) {
      if (!remote.cursor) continue;
      const x = remote.cursor.x * viewport.zoom + viewport.x;
      const y = remote.cursor.y * viewport.zoom + viewport.y;
      if (
        x < -50 ||
        y < -50 ||
        x > this.canvases.overlay.clientWidth + 100 ||
        y > this.canvases.overlay.clientHeight + 100
      ) {
        continue;
      }

      ctx.save();
      ctx.translate(x, y);
      ctx.fillStyle = remote.color;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(0, 18);
      ctx.lineTo(5, 14);
      ctx.lineTo(9, 22);
      ctx.lineTo(13, 20);
      ctx.lineTo(9, 12);
      ctx.lineTo(15, 12);
      ctx.closePath();
      ctx.fill();

      ctx.font = `600 11px ${FONT_STACK}`;
      const label = remote.name.slice(0, 40);
      const width = ctx.measureText(label).width + 12;
      ctx.fillStyle = remote.color;
      roundedRectPath(ctx, 13, 18, width, 20, 6);
      ctx.fill();
      ctx.fillStyle = contrastText(remote.color) || theme.cursorLabelText;
      ctx.textBaseline = "middle";
      ctx.fillText(label, 19, 28);
      ctx.restore();

      // Cursor chat bubble: a glass pill under the pointer, shown only while
      // the message is inside its active window.
      const chatText = remote.chatText;
      const activeUntil = remote.chatActiveUntil;
      const isActive =
        typeof chatText === "string" &&
        chatText.length > 0 &&
        (typeof activeUntil !== "number" || activeUntil > now);
      if (isActive && chatText) {
        this.drawChatBubble(ctx, x, y + 30, chatText, remote.color);
      }
    }
  }

  private drawChatBubble(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    text: string,
    color: string,
  ): void {
    ctx.save();
    ctx.font = `500 12px ${FONT_STACK}`;
    const lines = wrapLines(ctx, text, CHAT_BUBBLE_MAX_WIDTH - CHAT_BUBBLE_PADDING * 2);
    const lineHeight = 16;
    const width =
      Math.min(
        CHAT_BUBBLE_MAX_WIDTH,
        Math.max(...lines.map((line) => ctx.measureText(line).width)) + CHAT_BUBBLE_PADDING * 2,
      ) + 2;
    const height = lines.length * lineHeight + CHAT_BUBBLE_PADDING * 2;

    ctx.shadowColor = "rgba(2, 6, 23, 0.45)";
    ctx.shadowBlur = 18;
    ctx.shadowOffsetY = 6;
    roundedRectPath(ctx, x + 12, y, width, height, 12);
    ctx.fillStyle = "rgba(15, 23, 42, 0.82)";
    ctx.fill();
    ctx.shadowColor = "transparent";
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;

    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.fillStyle = "#f8fafc";
    ctx.textBaseline = "top";
    let lineY = y + CHAT_BUBBLE_PADDING;
    for (const line of lines) {
      ctx.fillText(line, x + 12 + CHAT_BUBBLE_PADDING, lineY);
      lineY += lineHeight;
    }
    ctx.restore();
  }

  readPresence(): RemotePresence[] {
    const presence: RemotePresence[] = [];
    for (const [clientId, state] of this.awareness.getStates()) {
      if (clientId === this.localClientId) continue;
      const user = state["user"];
      if (!isRecord(user)) continue;
      const userId = typeof user["id"] === "string" ? user["id"] : "";
      const name = typeof user["name"] === "string" ? user["name"] : "Anonymous";
      const color = isValidColor(user["color"]) ? user["color"] : "#f97316";
      const rawCursor = state["cursor"];
      const cursor =
        isRecord(rawCursor) &&
        isFiniteNumber(rawCursor["x"]) &&
        isFiniteNumber(rawCursor["y"])
          ? { x: rawCursor["x"], y: rawCursor["y"] }
          : null;
      const rawSelection = state["selection"];
      const selection = Array.isArray(rawSelection)
        ? rawSelection.filter((value): value is string => typeof value === "string").slice(0, 25)
        : [];
      const chatText = typeof state["chatText"] === "string" ? state["chatText"] : null;
      const chatActiveUntil = isFiniteNumber(state["chatActiveUntil"])
        ? state["chatActiveUntil"]
        : null;
      const followingUserId =
        typeof state["followingUserId"] === "string" ? state["followingUserId"] : null;
      presence.push({
        clientId,
        userId,
        name: name.slice(0, 80),
        color,
        cursor,
        selection,
        chatText,
        chatActiveUntil,
        followingUserId,
      });
    }
    return presence;
  }

  private updatePeerCount(): void {
    let count = 0;
    for (const [clientId, state] of this.awareness.getStates()) {
      if (clientId === this.localClientId) continue;
      if (isRecord(state["user"])) count += 1;
    }
    if (count !== this.lastPeerCount) {
      this.lastPeerCount = count;
      this.store.getState().setPeerCount(count);
    }
  }
}

function roundedRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  const left = Math.min(x, x + width);
  const top = Math.min(y, y + height);
  const w = Math.abs(width);
  const h = Math.abs(height);
  const r = Math.min(radius, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(left + r, top);
  ctx.lineTo(left + w - r, top);
  ctx.quadraticCurveTo(left + w, top, left + w, top + r);
  ctx.lineTo(left + w, top + h - r);
  ctx.quadraticCurveTo(left + w, top + h, left + w - r, top + h);
  ctx.lineTo(left + r, top + h);
  ctx.quadraticCurveTo(left, top + h, left, top + h - r);
  ctx.lineTo(left, top + r);
  ctx.quadraticCurveTo(left, top, left + r, top);
  ctx.closePath();
}

function wrapLines(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
): string[] {
  const output: string[] = [];
  const chunks = text.replace(/\r\n/g, "\n").split("\n");
  for (const chunk of chunks) {
    if (chunk.length === 0) {
      output.push("");
      continue;
    }
    let line = "";
    for (const word of chunk.split(/(\s+)/)) {
      if (word.length === 0) continue;
      const candidate = line + word;
      if (ctx.measureText(candidate).width <= maxWidth || line.length === 0) {
        line = candidate;
      } else {
        output.push(line.trimEnd());
        line = word.trimStart();
      }
    }
    output.push(line.trimEnd());
  }
  return output.slice(0, 200);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
