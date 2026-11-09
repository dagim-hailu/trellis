import { createStore, type StoreApi } from "zustand/vanilla";

import type { CanvasLayer } from "@trellis/shared";

import type { ThemeName } from "@/lib/theme-config";

export const CANVAS_TOOLS = [
  "select",
  "hand",
  "rect",
  "ellipse",
  "text",
  "note",
  "path",
  "frame",
  "connector",
  "comment",
] as const;
export type CanvasTool = (typeof CANVAS_TOOLS)[number];

export type ConnectionState = "connecting" | "connected" | "disconnected" | "closed";

export interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

/** Screen-space anchor for the floating selection toolbar. */
export interface ToolbarAnchor {
  x: number;
  y: number;
  visible: boolean;
}

export interface CanvasUiState {
  tool: CanvasTool;
  theme: ThemeName;
  activeLayerId: string;
  selectedNodeIds: string[];
  layers: CanvasLayer[];
  viewport: Viewport;
  cursorWorld: { x: number; y: number } | null;
  connection: ConnectionState;
  synced: boolean;
  peerCount: number;
  readOnly: boolean;
  notice: string | null;
  /** True while a modal text editor or shortcut sheet owns keyboard input. */
  overlayOpen: boolean;
  /** Bumped when node values change so inspector components can refresh. */
  revision: number;

  // -- Phase 4/5 UI state ---------------------------------------------------
  /** User id the local viewport is following, or null. */
  followUserId: string | null;
  /** Command palette visibility. */
  paletteOpen: boolean;
  /** AI prompt modal visibility. */
  aiPromptOpen: boolean;
  /** Floating selection toolbar anchor in screen coordinates. */
  toolbarAnchor: ToolbarAnchor;
  /** Comment thread currently open in the popover, or null. */
  activeCommentId: string | null;
  /** Cursor-chat input visibility. */
  cursorChatOpen: boolean;
}

export interface CanvasUiActions {
  setTool: (tool: CanvasTool) => void;
  setTheme: (theme: ThemeName) => void;
  setActiveLayerId: (layerId: string) => void;
  setSelectedNodeIds: (ids: string[]) => void;
  setLayers: (layers: CanvasLayer[]) => void;
  setViewport: (viewport: Viewport) => void;
  setCursorWorld: (cursor: { x: number; y: number } | null) => void;
  setConnection: (connection: ConnectionState) => void;
  setSynced: (synced: boolean) => void;
  setPeerCount: (count: number) => void;
  setNotice: (notice: string | null) => void;
  setOverlayOpen: (open: boolean) => void;
  markNodesChanged: () => void;
  setFollowUserId: (userId: string | null) => void;
  setPaletteOpen: (open: boolean) => void;
  setAiPromptOpen: (open: boolean) => void;
  setToolbarAnchor: (anchor: ToolbarAnchor) => void;
  setActiveCommentId: (commentId: string | null) => void;
  setCursorChatOpen: (open: boolean) => void;
}

export type CanvasUiStore = StoreApi<CanvasUiState & CanvasUiActions>;

export function createCanvasUiStore(readOnly: boolean, theme: ThemeName): CanvasUiStore {
  return createStore<CanvasUiState & CanvasUiActions>()((set, get) => ({
    tool: "select",
    theme,
    activeLayerId: "layer-default",
    selectedNodeIds: [],
    layers: [],
    viewport: { x: 80, y: 80, zoom: 1 },
    cursorWorld: null,
    connection: "connecting",
    synced: false,
    peerCount: 0,
    readOnly,
    notice: null,
    overlayOpen: false,
    revision: 0,
    followUserId: null,
    paletteOpen: false,
    aiPromptOpen: false,
    toolbarAnchor: { x: 0, y: 0, visible: false },
    activeCommentId: null,
    cursorChatOpen: false,
    setTool: (tool) => set({ tool }),
    setTheme: (theme) => set({ theme }),
    setActiveLayerId: (activeLayerId) => set({ activeLayerId }),
    setSelectedNodeIds: (selectedNodeIds) =>
      set((state) => {
        const current = state.selectedNodeIds;
        if (
          current.length === selectedNodeIds.length &&
          current.every((id, index) => id === selectedNodeIds[index])
        ) {
          return state;
        }
        return { selectedNodeIds };
      }),
    setLayers: (layers) => set({ layers }),
    setViewport: (viewport) => set({ viewport }),
    setCursorWorld: (cursorWorld) => set({ cursorWorld }),
    setConnection: (connection) => set({ connection }),
    setSynced: (synced) => set({ synced }),
    setPeerCount: (peerCount) => {
      if (get().peerCount !== peerCount) set({ peerCount });
    },
    setNotice: (notice) => set({ notice }),
    setOverlayOpen: (overlayOpen) => set({ overlayOpen }),
    markNodesChanged: () => set((state) => ({ revision: state.revision + 1 })),
    setFollowUserId: (followUserId) => set({ followUserId }),
    setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
    setAiPromptOpen: (aiPromptOpen) => set({ aiPromptOpen }),
    setToolbarAnchor: (toolbarAnchor) => set({ toolbarAnchor }),
    setActiveCommentId: (activeCommentId) => set({ activeCommentId }),
    setCursorChatOpen: (cursorChatOpen) => set({ cursorChatOpen }),
  }));
}
