"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "zustand";
import { IndexeddbPersistence } from "y-indexeddb";
import { WebsocketProvider } from "y-websocket";
import * as Y from "yjs";

import {
  randomPresenceColor,
  type AssetDto,
  type CanvasNode,
  type CommentDto,
  type DocumentDto,
} from "@trellis/shared";

import { createAiProvider, type AiAction } from "@/canvas/ai";
import { CanvasController } from "@/canvas/controller";
import {
  ensureDefaultLayer,
  getCanvasMaps,
  readLayers,
  type CanvasMaps,
} from "@/canvas/model";
import { CanvasRenderer, type RemotePresence } from "@/canvas/renderer";
import { CANVAS_TOOLS, createCanvasUiStore, type CanvasTool } from "@/canvas/store";
import { AiPromptModal } from "@/components/AiPromptModal";
import { AssetLibraryDialog } from "@/components/AssetLibraryDialog";
import { CanvasComments } from "@/components/CanvasComments";
import { CanvasToolsDialog } from "@/components/CanvasToolsDialog";
import { CommandPalette, type PaletteCommand } from "@/components/CommandPalette";
import { CursorChat } from "@/components/CursorChat";
import { FloatingSelectionToolbar } from "@/components/FloatingSelectionToolbar";
import { InPlaceTextEditor } from "@/components/InPlaceTextEditor";
import { LayerPanel } from "@/components/LayerPanel";
import { PresenceBar } from "@/components/PresenceBar";
import { SelectionInspector } from "@/components/SelectionInspector";
import { ShortcutsDialog } from "@/components/ShortcutsDialog";
import { ThemeSwitcher } from "@/components/ThemeSwitcher";
import { useTheme } from "@/components/ThemeProvider";
import { ZoomControls } from "@/components/ZoomControls";
import {
  createCommentRequest,
  listComments,
  resolveComment,
} from "@/lib/api";
import { REALTIME_DOCUMENTS_URL } from "@/lib/env";
import type { BrowserSession } from "@/lib/session";

interface CanvasEngineProps {
  document: DocumentDto;
  session: BrowserSession;
  onExpired: () => void;
}

interface TextEditState {
  nodeId: string;
  value: string;
}

const TOOL_LABELS: Record<CanvasTool, { label: string; key: string }> = {
  select: { label: "Select", key: "V" },
  hand: { label: "Pan", key: "H" },
  rect: { label: "Rectangle", key: "R" },
  ellipse: { label: "Ellipse", key: "O" },
  text: { label: "Text", key: "T" },
  note: { label: "Sticky note", key: "N" },
  path: { label: "Draw", key: "P" },
  frame: { label: "Frame", key: "F" },
  connector: { label: "Connector", key: "L" },
  comment: { label: "Comment", key: "C" },
};

export function CanvasEngine({ document, session, onExpired }: CanvasEngineProps) {
  const { theme } = useTheme();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const gridCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const rendererRef = useRef<CanvasRenderer | null>(null);
  const controllerRef = useRef<CanvasController | null>(null);
  const providerRef = useRef<WebsocketProvider | null>(null);
  const copiedReset = useRef<number | null>(null);
  const [uiStore] = useState(() => createCanvasUiStore(document.role === "viewer", theme));
  const [ready, setReady] = useState(false);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [editing, setEditing] = useState<TextEditState | null>(null);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [copied, setCopied] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [peers, setPeers] = useState<RemotePresence[]>([]);
  const [comments, setComments] = useState<CommentDto[]>([]);
  const [pendingPin, setPendingPin] = useState<{ x: number; y: number } | null>(null);
  const [chatAnchor, setChatAnchor] = useState<{ x: number; y: number } | null>(null);
  const [gridVisible, setGridVisible] = useState(true);
  const [assetDialogOpen, setAssetDialogOpen] = useState(false);
  const [canvasToolsOpen, setCanvasToolsOpen] = useState(false);

  const tool = useStore(uiStore, (state) => state.tool);
  const connection = useStore(uiStore, (state) => state.connection);
  const synced = useStore(uiStore, (state) => state.synced);
  const peerCount = useStore(uiStore, (state) => state.peerCount);
  const notice = useStore(uiStore, (state) => state.notice);
  const readOnly = useStore(uiStore, (state) => state.readOnly);
  const viewport = useStore(uiStore, (state) => state.viewport);
  const selectedNodeIds = useStore(uiStore, (state) => state.selectedNodeIds);
  const revision = useStore(uiStore, (state) => state.revision);
  const paletteOpen = useStore(uiStore, (state) => state.paletteOpen);
  const aiPromptOpen = useStore(uiStore, (state) => state.aiPromptOpen);
  const toolbarAnchor = useStore(uiStore, (state) => state.toolbarAnchor);
  const activeCommentId = useStore(uiStore, (state) => state.activeCommentId);
  const cursorChatOpen = useStore(uiStore, (state) => state.cursorChatOpen);
  const followUserId = useStore(uiStore, (state) => state.followUserId);

  const aiProvider = useMemo(
    () => createAiProvider(process.env["NEXT_PUBLIC_AI_ENDPOINT"]),
    [],
  );

  const selectedNodes = useMemo(() => {
    const controller = controllerRef.current;
    if (!controller) return [];
    return selectedNodeIds
      .map((id) => controller.getNode(id))
      .filter((node): node is CanvasNode => node !== null);
  }, [selectedNodeIds, revision]);

  const allNodes = useMemo(() => {
    const controller = controllerRef.current;
    if (!controller) return [];
    return controller.getAllNodes();
  }, [revision]);

  const components = useMemo(() => {
    const controller = controllerRef.current;
    return controller?.getComponents() ?? [];
  }, [revision]);

  const openTextEditor = useCallback((nodeId: string, initialText: string) => {
    setEditing({ nodeId, value: initialText });
  }, []);

  useEffect(() => {
    uiStore.getState().setTheme(theme);
  }, [theme, uiStore]);

  useEffect(() => {
    uiStore.getState().setOverlayOpen(showShortcuts || editing !== null || paletteOpen || aiPromptOpen);
  }, [aiPromptOpen, editing, paletteOpen, showShortcuts, uiStore]);

  // Poll presence for the avatar stack. Awareness is an event emitter, but the
  // React tree only needs a coarse snapshot, so a 1s cadence avoids re-rendering
  // the header on every cursor move.
  useEffect(() => {
    const timer = window.setInterval(() => {
      const renderer = rendererRef.current;
      if (!renderer) return;
      const next = renderer.readPresence();
      setPeers((current) => {
        if (
          current.length === next.length &&
          current.every((peer, index) => peer.clientId === next[index]?.clientId)
        ) {
          return current;
        }
        return next;
      });
    }, 1_000);
    return () => window.clearInterval(timer);
  }, []);

  // Keep the floating toolbar anchored to the selection's screen-space bounds.
  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer || selectedNodeIds.length === 0) {
      uiStore.getState().setToolbarAnchor({ x: 0, y: 0, visible: false });
      return;
    }
    const nodes = selectedNodeIds
      .map((id) => controllerRef.current?.getNode(id) ?? null)
      .filter((node): node is CanvasNode => node !== null);
    if (nodes.length === 0) {
      uiStore.getState().setToolbarAnchor({ x: 0, y: 0, visible: false });
      return;
    }
    const minX = Math.min(...nodes.map((node) => node.x));
    const minY = Math.min(...nodes.map((node) => node.y));
    const maxX = Math.max(...nodes.map((node) => node.x + node.width));
    const topLeft = renderer.worldToScreen(minX, minY);
    const bottomRight = renderer.worldToScreen(maxX, minY);
    uiStore.getState().setToolbarAnchor({
      x: (topLeft.x + bottomRight.x) / 2,
      y: topLeft.y,
      visible: topLeft.y > 64,
    });
  }, [selectedNodeIds, revision, viewport, uiStore]);

  // Follow mode: interpolate the viewport toward the followed user's cursor.
  useEffect(() => {
    if (!followUserId) return;
    let frame = 0;
    const step = (): void => {
      const renderer = rendererRef.current;
      const peer = peers.find((candidate) => candidate.userId === followUserId);
      if (!renderer || !peer?.cursor) {
        frame = window.requestAnimationFrame(step);
        return;
      }
      const state = uiStore.getState();
      const size = renderer.getViewportSize();
      const targetX = size.width / 2 - peer.cursor.x * state.viewport.zoom;
      const targetY = size.height / 2 - peer.cursor.y * state.viewport.zoom;
      const nextX = state.viewport.x + (targetX - state.viewport.x) * 0.12;
      const nextY = state.viewport.y + (targetY - state.viewport.y) * 0.12;
      if (Math.hypot(nextX - state.viewport.x, nextY - state.viewport.y) > 0.4) {
        state.setViewport({ ...state.viewport, x: nextX, y: nextY });
      }
      frame = window.requestAnimationFrame(step);
    };
    frame = window.requestAnimationFrame(step);
    return () => window.cancelAnimationFrame(frame);
  }, [followUserId, peers, uiStore]);

  useEffect(() => {
    let disposed = false;
    let ydoc: Y.Doc | null = null;
    let idb: IndexeddbPersistence | null = null;
    let provider: WebsocketProvider | null = null;
    let renderer: CanvasRenderer | null = null;
    let controller: CanvasController | null = null;
    let maps: CanvasMaps | null = null;
    let syncLayers: (() => void) | null = null;
    let markNodesChanged: (() => void) | null = null;

    const setup = async (): Promise<void> => {
      ydoc = new Y.Doc();
      idb = new IndexeddbPersistence(`trellis:${document.id}`, ydoc);

      try {
        await Promise.race([
          idb.whenSynced,
          new Promise<void>((resolve) => setTimeout(resolve, 2_500)),
        ]);
      } catch {
        uiStore
          .getState()
          .setNotice("IndexedDB is unavailable. Edits will only survive while this tab is open.");
      }
      if (disposed) return;

      maps = getCanvasMaps(ydoc);
      ensureDefaultLayer(ydoc, maps);

      provider = new WebsocketProvider(REALTIME_DOCUMENTS_URL, document.id, ydoc, {
        connect: false,
        protocols: ["trellis.v1", `bearer.${session.accessToken}`],
        maxBackoffTime: 5_000,
        resyncInterval: 30_000,
      });
      provider.awareness.setLocalStateField("user", {
        id: session.user.id,
        name: session.user.displayName,
        color: randomPresenceColor(session.user.id),
      });

      provider.on("status", ({ status }) => {
        if (disposed) return;
        uiStore.getState().setConnection(status);
        if (status === "disconnected") uiStore.getState().setSynced(false);
      });
      provider.on("sync", (isSynced) => {
        if (!disposed) uiStore.getState().setSynced(Boolean(isSynced));
      });
      provider.on("closed", ({ code, reason }) => {
        if (disposed) return;
        uiStore.getState().setConnection("closed");
        uiStore.getState().setSynced(false);
        const message =
          code === 4403
            ? "Your access to this canvas changed. Reload after checking your permissions."
            : reason || "The realtime session was closed.";
        uiStore.getState().setNotice(message);
      });

      const canvas = canvasRef.current;
      const gridCanvas = gridCanvasRef.current;
      const overlayCanvas = overlayCanvasRef.current;
      if (!canvas || !gridCanvas || !overlayCanvas) {
        throw new Error("Canvas elements are not mounted");
      }

      renderer = new CanvasRenderer(
        { grid: gridCanvas, scene: canvas, overlay: overlayCanvas },
        maps,
        provider.awareness,
        uiStore,
        ydoc.clientID,
        session.accessToken,
      );
      rendererRef.current = renderer;
      providerRef.current = provider;
      controller = new CanvasController({
        canvas,
        doc: ydoc,
        maps,
        awareness: provider.awareness,
        store: uiStore,
        renderer,
        user: { id: session.user.id, name: session.user.displayName },
        readOnly: document.role === "viewer",
        onEditText: openTextEditor,
        onCommentPlace: (x, y) => {
          setPendingPin({ x, y });
          uiStore.getState().setTool("select");
        },
      });
      controller.start();
      controllerRef.current = controller;

      const layerMaps = maps;
      syncLayers = () => {
        const nextLayers = readLayers(layerMaps);
        uiStore.getState().setLayers(nextLayers);
        const active = uiStore.getState().activeLayerId;
        if (!nextLayers.some((layer) => layer.id === active)) {
          const fallback = nextLayers.find((layer) => layer.visible) ?? nextLayers[0];
          if (fallback) uiStore.getState().setActiveLayerId(fallback.id);
        }
      };
      markNodesChanged = () => uiStore.getState().markNodesChanged();
      layerMaps.layers.observeDeep(syncLayers);
      layerMaps.nodes.observeDeep(markNodesChanged);
      syncLayers();

      provider.connect();
      if (!disposed) setReady(true);
    };

    void setup().catch((error: unknown) => {
      if (disposed) return;
      setSetupError(error instanceof Error ? error.message : "Failed to initialize the canvas");
      uiStore.getState().setConnection("closed");
    });

    return () => {
      disposed = true;
      if (maps && syncLayers) maps.layers.unobserveDeep(syncLayers);
      if (maps && markNodesChanged) maps.nodes.unobserveDeep(markNodesChanged);
      controller?.destroy();
      renderer?.destroy();
      controllerRef.current = null;
      rendererRef.current = null;
      providerRef.current = null;
      if (provider) {
        provider.awareness.setLocalState(null);
        provider.destroy();
      }
      if (idb) void idb.destroy();
      ydoc?.destroy();
    };
  }, [
    document.id,
    document.role,
    openTextEditor,
    session.accessToken,
    session.user.displayName,
    session.user.id,
    uiStore,
  ]);

  useEffect(() => {
    if (!editing) return;
    const timer = window.setTimeout(() => {
      const field = window.document.getElementById("text-block-editor") as HTMLTextAreaElement | null;
      field?.focus();
      field?.select();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [editing]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (session.expiresAt <= Date.now()) onExpired();
    }, Math.max(0, session.expiresAt - Date.now()));
    return () => window.clearTimeout(timer);
  }, [onExpired, session.expiresAt]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const typing = isTypingTarget(event.target);

      // Cmd/Ctrl+K opens the palette from anywhere, including a text field.
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        uiStore.getState().setPaletteOpen(!uiStore.getState().paletteOpen);
        return;
      }
      // Cmd/Ctrl+J opens the AI co-designer.
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "j") {
        event.preventDefault();
        uiStore.getState().setAiPromptOpen(!uiStore.getState().aiPromptOpen);
        return;
      }
      if (typing) return;

      // `/` opens cursor chat at the pointer.
      if (event.key === "/" && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault();
        const cursor = uiStore.getState().cursorWorld;
        const renderer = rendererRef.current;
        if (cursor && renderer) {
          setChatAnchor(renderer.worldToScreen(cursor.x, cursor.y));
        } else {
          setChatAnchor({ x: 80, y: 120 });
        }
        uiStore.getState().setCursorChatOpen(true);
        return;
      }

      if (event.key === "?" && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault();
        setShowShortcuts((current) => !current);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [uiStore]);

  useEffect(
    () => () => {
      if (copiedReset.current) window.clearTimeout(copiedReset.current);
    },
    [],
  );

  const paletteCommands = useMemo<PaletteCommand[]>(() => {
    const controller = controllerRef.current;
    const insert = (label: string, tool: CanvasTool): PaletteCommand => ({
      id: `insert-${tool}`,
      label,
      group: "Insert",
      run: () => uiStore.getState().setTool(tool),
    });
    return [
      insert("Insert rectangle", "rect"),
      insert("Insert ellipse", "ellipse"),
      insert("Insert sticky note", "note"),
      insert("Insert text", "text"),
      insert("Insert frame", "frame"),
      insert("Draw freehand", "path"),
      insert("Draw connector", "connector"),
      insert("Add comment", "comment"),
      {
        id: "fit-all",
        label: "Zoom to fit all content",
        group: "Navigate",
        run: () => controller?.fitToContent(),
      },
      {
        id: "reset-zoom",
        label: "Reset zoom to 100%",
        group: "Navigate",
        run: () => controller?.resetZoom(),
      },
      {
        id: "ai-mind-map",
        label: "AI: generate a mind map",
        group: "Canvas",
        run: () => uiStore.getState().setAiPromptOpen(true),
      },
    ];
  }, [uiStore]);

  const saveEditing = (): void => {
    if (!editing) return;
    controllerRef.current?.applyText(editing.nodeId, editing.value);
    setEditing(null);
  };

  const refreshComments = useCallback(async (): Promise<void> => {
    try {
      const result = await listComments(document.id, session.accessToken);
      setComments(result);
    } catch {
      // Comments are an enhancement; a failure must not break the canvas.
    }
  }, [document.id, session.accessToken]);

  useEffect(() => {
    void refreshComments();
  }, [refreshComments]);

  const createComment = useCallback(
    async (x: number, y: number, content: string): Promise<void> => {
      const created = await createCommentRequest(document.id, session.accessToken, {
        x,
        y,
        content,
      });
      setComments((current) => [...current, created]);
    },
    [document.id, session.accessToken],
  );

  const replyToComment = useCallback(
    async (parentId: string, content: string): Promise<void> => {
      const parent = comments.find((comment) => comment.id === parentId);
      if (!parent) return;
      const created = await createCommentRequest(document.id, session.accessToken, {
        x: parent.x,
        y: parent.y,
        content,
        parentCommentId: parentId,
      });
      setComments((current) => [...current, created]);
    },
    [comments, document.id, session.accessToken],
  );

  const toggleResolved = useCallback(
    async (commentId: string, resolved: boolean): Promise<void> => {
      const updated = await resolveComment(commentId, session.accessToken, resolved);
      setComments((current) =>
        current.map((comment) => (comment.id === commentId ? updated : comment)),
      );
    },
    [session.accessToken],
  );

  const sendCursorChat = useCallback(
    (text: string) => {
      const provider = providerRef.current;
      if (!provider) return;
      provider.awareness.setLocalStateField("chatText", text);
      provider.awareness.setLocalStateField("chatActiveUntil", Date.now() + 6_000);
      window.setTimeout(() => {
        provider.awareness.setLocalStateField("chatText", null);
        provider.awareness.setLocalStateField("chatActiveUntil", null);
      }, 6_000);
    },
    [],
  );

  const runAiAction = useCallback(
    async (action: AiAction, topic: string): Promise<string> => {
      const controller = controllerRef.current;
      if (!controller) return "The canvas is not ready yet.";

      if (action === "mind-map") {
        const specs = await aiProvider.generateMindMap(topic);
        const created = controller.insertAiNodes(
          specs.map((spec) => ({
            type: spec.kind === "root" ? "ellipse" : spec.kind === "branch" ? "note" : "rect",
            x: spec.x,
            y: spec.y,
            width: spec.width,
            height: spec.height,
            text: spec.text,
          })),
        );
        return `Created ${created.length} nodes. Undo with Cmd/Ctrl+Z.`;
      }

      if (action === "arrange") {
        const plans = await aiProvider.arrangeSelection(selectedNodes);
        if (plans.length === 0) return "Select some notes first.";
        controller.moveNodesTo(plans);
        return `Arranged ${plans.length} notes into ${new Set(plans.map((plan) => plan.column)).size} columns.`;
      }

      const summary = await aiProvider.summarizeNotes(selectedNodes);
      if (summary.bullets.length === 0) return summary.summary;
      const anchorX = Math.max(...selectedNodes.map((node) => node.x + node.width)) + 60;
      const anchorY = Math.min(...selectedNodes.map((node) => node.y));
      controller.insertAiNodes([
        {
          type: "note",
          x: anchorX,
          y: anchorY,
          width: 300,
          height: 40 + summary.bullets.length * 26,
          text: [summary.summary, ...summary.bullets.map((bullet) => `• ${bullet}`)].join("\n"),
        },
      ]);
      return "Added a summary card next to the selection.";
    },
    [aiProvider, selectedNodes],
  );

  const copyLink = async (): Promise<void> => {
    const url = window.location.href;
    try {
      await copyText(url);
      setCopied(true);
      if (copiedReset.current) window.clearTimeout(copiedReset.current);
      copiedReset.current = window.setTimeout(() => setCopied(false), 1_800);
    } catch {
      uiStore.getState().setNotice("Could not copy the link. Copy it from the address bar.");
    }
  };

  const exportPng = async (): Promise<void> => {
    const renderer = rendererRef.current;
    if (!renderer || exporting) return;
    setExporting(true);
    try {
      const blob = await renderer.exportPng();
      if (!blob) throw new Error("Canvas export returned no image");
      const url = URL.createObjectURL(blob);
      const link = window.document.createElement("a");
      link.href = url;
      link.download = `${document.title.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "trellis-canvas"}.png`;
      window.document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
    } catch (error) {
      uiStore
        .getState()
        .setNotice(error instanceof Error ? error.message : "Could not export the canvas.");
    } finally {
      setExporting(false);
    }
  };

  const editingNode = editing ? controllerRef.current?.getNode(editing.nodeId) : null;

  return (
    <div className="canvas-shell">
      <header className="canvas-header">
        <div className="canvas-header-left">
          <a className="back-link" href="/" aria-label="Back to documents">
            ←
          </a>
          <div>
            <div className="canvas-title">{document.title}</div>
            <div className="canvas-subtitle">
              {document.role === "viewer" ? "View only" : "Live canvas"}
            </div>
          </div>
        </div>
        <div className="canvas-header-right">
          <span className={`status-pill status-${connection}`}>
            <span className="status-dot" />
            {connection === "connected"
              ? synced
                ? "Synced"
                : "Connecting sync"
              : connection === "connecting"
                ? "Connecting"
                : connection === "closed"
                  ? "Disconnected"
                  : "Offline"}
          </span>
          <span className="presence-count" title="People in this canvas">
            {peerCount + 1} online
          </span>
          <PresenceBar
            uiStore={uiStore}
            peers={peers}
            onFollow={(userId) => {
              uiStore.getState().setFollowUserId(userId);
              providerRef.current?.awareness.setLocalStateField("followingUserId", userId);
            }}
          />
          <span className={`role-badge role-${document.role}`}>{document.role}</span>
          <div className="canvas-actions">
            <button
              type="button"
              className="header-icon-button"
              title="Open reusable components and Canvas Compass"
              aria-label="Open components and Canvas Compass"
              onClick={() => setCanvasToolsOpen(true)}
            >
              <span className="header-icon-symbol" aria-hidden="true">⌘</span>
              <span className="header-icon-label">Components</span>
            </button>
            <button
              type="button"
              className="header-icon-button"
              title="Insert an image"
              aria-label="Insert an image"
              disabled={readOnly}
              onClick={() => setAssetDialogOpen(true)}
            >
              <span className="header-icon-symbol" aria-hidden="true">▧</span>
              <span className="header-icon-label">Image</span>
            </button>
            <button
              type="button"
              className="header-icon-button share"
              title="Copy canvas link"
              aria-label="Copy canvas link"
              onClick={() => void copyLink()}
            >
              <span className="header-icon-symbol" aria-hidden="true">↗</span>
              <span className="header-icon-label">{copied ? "Copied" : "Share"}</span>
            </button>
            <button
              type="button"
              className="header-icon-button export"
              title="Download current view as PNG"
              aria-label="Export canvas as PNG"
              disabled={exporting}
              onClick={() => void exportPng()}
            >
              <span className="header-icon-symbol" aria-hidden="true">↓</span>
              <span className="header-icon-label">{exporting ? "Saving…" : "Export"}</span>
            </button>
            <button
              type="button"
              className="header-icon-button help"
              title="Keyboard shortcuts (?)"
              aria-label="Show keyboard shortcuts"
              onClick={() => setShowShortcuts(true)}
            >
              ?
            </button>
            <ThemeSwitcher />
          </div>
          <a className="header-action" href="/">
            Documents
          </a>
        </div>
      </header>

      <div className="canvas-main">
        <div className="canvas-stage">
          <div className="canvas-stack">
            <canvas ref={gridCanvasRef} className="canvas-layer canvas-grid-layer" aria-hidden="true" style={{ display: gridVisible ? "block" : "none" }} />
            <canvas
              ref={canvasRef}
              className="canvas-layer canvas-surface"
              tabIndex={0}
              aria-label={`Collaborative canvas: ${document.title}`}
            />
            <canvas ref={overlayCanvasRef} className="canvas-layer canvas-overlay-layer" aria-hidden="true" />
          </div>

          <div className="tool-palette" role="toolbar" aria-label="Canvas tools">
            {CANVAS_TOOLS.map((candidate) => (
              <button
                key={candidate}
                type="button"
                className={`tool-button ${tool === candidate ? "active" : ""}`}
                title={`${TOOL_LABELS[candidate].label} (${TOOL_LABELS[candidate].key})`}
                aria-label={TOOL_LABELS[candidate].label}
                aria-pressed={tool === candidate}
                disabled={readOnly && candidate !== "select" && candidate !== "hand"}
                onClick={() => uiStore.getState().setTool(candidate)}
              >
                <ToolIcon tool={candidate} />
              </button>
            ))}
            <span className="tool-divider" />
            <button
              type="button"
              className="tool-button"
              title="Undo (Cmd/Ctrl+Z)"
              aria-label="Undo"
              disabled={readOnly}
              onClick={() => controllerRef.current?.undo()}
            >
              <HistoryIcon direction="undo" />
            </button>
            <button
              type="button"
              className="tool-button"
              title="Redo (Cmd/Ctrl+Shift+Z)"
              aria-label="Redo"
              disabled={readOnly}
              onClick={() => controllerRef.current?.redo()}
            >
              <HistoryIcon direction="redo" />
            </button>
          </div>

          <aside className="right-rail">
            <LayerPanel uiStore={uiStore} controllerRef={controllerRef} readOnly={readOnly} />
            <SelectionInspector
              uiStore={uiStore}
              controllerRef={controllerRef}
              readOnly={readOnly}
              onEditText={openTextEditor}
            />
          </aside>

          <ZoomControls uiStore={uiStore} controllerRef={controllerRef} />

          <FloatingSelectionToolbar
            uiStore={uiStore}
            controller={controllerRef.current}
            anchor={toolbarAnchor}
            selectedNodes={selectedNodes}
            readOnly={readOnly}
            onOpenAi={() => uiStore.getState().setAiPromptOpen(true)}
          />

          <CanvasComments
            comments={comments}
            viewport={viewport}
            readOnly={readOnly}
            activeCommentId={activeCommentId}
            onSelect={(commentId) => uiStore.getState().setActiveCommentId(commentId)}
            onCreate={createComment}
            onReply={replyToComment}
            onToggleResolved={toggleResolved}
            pendingPin={pendingPin}
            onCancelPending={() => setPendingPin(null)}
          />

          <CursorChat
            open={cursorChatOpen}
            anchor={chatAnchor}
            onSend={sendCursorChat}
            onClose={() => uiStore.getState().setCursorChatOpen(false)}
          />

          {!ready && !setupError ? (
            <div className="canvas-loading">
              <span className="spinner" />
              Opening canvas and local history…
            </div>
          ) : null}

          {setupError ? (
            <div className="canvas-error">
              <h2>Canvas unavailable</h2>
              <p>{setupError}</p>
              <a href="/">Return to documents</a>
            </div>
          ) : null}

          {notice ? <div className="canvas-notice">{notice}</div> : null}

          <div className="canvas-hint">
            {readOnly
              ? "View only · space + drag to pan · scroll to zoom · ? shortcuts"
              : "Space + drag pan · scroll zoom · double-click text · ? shortcuts"}
          </div>
        </div>
      </div>

      {editing && editingNode ? (
        <InPlaceTextEditor
          node={editingNode}
          value={editing.value}
          viewport={viewport}
          onChange={(value) => setEditing({ ...editing, value })}
          onCommit={saveEditing}
          onCancel={() => setEditing(null)}
        />
      ) : null}

      {showShortcuts ? <ShortcutsDialog onClose={() => setShowShortcuts(false)} /> : null}

      <CommandPalette
        open={paletteOpen}
        onClose={() => uiStore.getState().setPaletteOpen(false)}
        commands={paletteCommands}
        nodes={allNodes}
        onJumpToNode={(nodeId) => controllerRef.current?.jumpToNode(nodeId)}
        onSetTheme={(next) => uiStore.getState().setTheme(next)}
        onToggleGrid={() => setGridVisible((current) => !current)}
        onExport={() => void exportPng()}
      />

      <AiPromptModal
        open={aiPromptOpen}
        onClose={() => uiStore.getState().setAiPromptOpen(false)}
        onRun={runAiAction}
        providerName={aiProvider.name}
        hasSelection={selectedNodeIds.length > 0}
      />

      <AssetLibraryDialog
        open={assetDialogOpen}
        workspaceId={document.workspaceId}
        accessToken={session.accessToken}
        canUpload={!readOnly}
        onClose={() => setAssetDialogOpen(false)}
        onInsert={(asset: AssetDto) => {
          controllerRef.current?.insertImageAsset(asset);
          setAssetDialogOpen(false);
          canvasRef.current?.focus();
        }}
      />

      <CanvasToolsDialog
        open={canvasToolsOpen}
        components={components}
        nodes={allNodes}
        comments={comments}
        selectedCount={selectedNodeIds.length}
        canEdit={!readOnly}
        onClose={() => setCanvasToolsOpen(false)}
        onCreateComponent={(name) => Boolean(controllerRef.current?.createComponent(name))}
        onInsertComponent={(id) => controllerRef.current?.insertComponent(id)}
        onSelectNode={(id) => {
          controllerRef.current?.setSelection([id]);
          controllerRef.current?.jumpToNode(id);
        }}
        onReviewComment={(id) => {
          uiStore.getState().setActiveCommentId(id);
          setCanvasToolsOpen(false);
        }}
      />
    </div>
  );
}

function ToolIcon({ tool }: { tool: CanvasTool }) {
  const common = {
    width: 18,
    height: 18,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };

  switch (tool) {
    case "select":
      return (
        <svg {...common} fill="currentColor" stroke="none">
          <path d="m4.5 3.2 15.2 8.1-6.5 1.7-3.1 6.1L4.5 3.2Z" />
        </svg>
      );
    case "hand":
      return (
        <svg {...common}>
          <path d="M18 11V6.5a1.8 1.8 0 0 0-3.6 0V10" />
          <path d="M14.4 10V4.8a1.8 1.8 0 0 0-3.6 0V10" />
          <path d="M10.8 10.4V6.4a1.8 1.8 0 0 0-3.6 0v8.1" />
          <path d="M18 9.5a1.8 1.8 0 0 1 3.6 0v5.2A7.3 7.3 0 0 1 14.3 22h-1.8a6.7 6.7 0 0 1-5-2.1l-3-3.3a1.9 1.9 0 0 1 2.7-2.6l1.9 1.8" />
        </svg>
      );
    case "rect":
      return (
        <svg {...common}>
          <rect x="3.5" y="5" width="17" height="14" rx="2.2" />
        </svg>
      );
    case "ellipse":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="8.4" />
        </svg>
      );
    case "text":
      return (
        <svg {...common}>
          <path d="M5 5.5h14M12 5.5V19M8.5 19h7" />
        </svg>
      );
    case "note":
      return (
        <svg {...common}>
          <path d="M5 4.5h14v9.7L14.2 19H5V4.5Z" />
          <path d="M14 19v-4.8h4.8M8 8h6M8 11.5h4.5" />
        </svg>
      );
    case "path":
      return (
        <svg {...common}>
          <path d="M4 17c3.2 0 3.4-9 6.6-9s3.4 9 6.6 9" />
          <circle cx="4" cy="17" r="1.4" fill="currentColor" stroke="none" />
          <circle cx="17.2" cy="17" r="1.4" fill="currentColor" stroke="none" />
        </svg>
      );
    case "frame":
      return (
        <svg {...common}>
          <path d="M8 3v18M16 3v18M3 8h18M3 16h18" />
        </svg>
      );
    case "connector":
      return (
        <svg {...common}>
          <path d="M4 18 18 6" />
          <path d="m13.6 5.6 4.8.4-.4 4.8" />
          <circle cx="4" cy="18" r="1.6" />
        </svg>
      );
    case "comment":
      return (
        <svg {...common}>
          <path d="M4.5 5.5h15v10h-8.4L6.6 19v-3.5H4.5v-10Z" />
          <path d="M8.5 9h7M8.5 12h4.5" />
        </svg>
      );
  }
}

function HistoryIcon({ direction }: { direction: "undo" | "redo" }) {
  const common = {
    width: 18,
    height: 18,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
  if (direction === "undo") {
    return (
      <svg {...common}>
        <path d="m9 14-5-5 5-5" />
        <path d="M4 9h9a7 7 0 0 1 0 14h-3" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <path d="m15 14 5-5-5-5" />
      <path d="M20 9h-9a7 7 0 0 0 0 14h3" />
    </svg>
  );
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select" || target.isContentEditable;
}

async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const field = document.createElement("textarea");
  field.value = text;
  field.setAttribute("readonly", "");
  field.style.position = "fixed";
  field.style.opacity = "0";
  document.body.appendChild(field);
  field.select();
  const copied = document.execCommand("copy");
  field.remove();
  if (!copied) throw new Error("Clipboard write was rejected");
}
