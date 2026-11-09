"use client";

import { useStore } from "zustand";

import type { CanvasNode, CurveType } from "@trellis/shared";

import type { CanvasController } from "@/canvas/controller";
import type { CanvasUiStore, ToolbarAnchor } from "@/canvas/store";
import { FILL_SWATCHES } from "@/lib/theme-config";

export interface FloatingSelectionToolbarProps {
  uiStore: CanvasUiStore;
  controller: CanvasController | null;
  anchor: ToolbarAnchor;
  selectedNodes: readonly CanvasNode[];
  readOnly: boolean;
  onOpenAi: () => void;
}

/**
 * Contextual floating island anchored above the selection's bounding box.
 *
 * The control set adapts to what is selected: fill swatches only make sense for
 * shapes and notes, connector style only for connectors, font controls only for
 * text-bearing nodes. Showing every control for every selection is what makes
 * these toolbars feel like a settings panel instead of a tool.
 */
export function FloatingSelectionToolbar({
  uiStore,
  controller,
  anchor,
  selectedNodes,
  readOnly,
  onOpenAi,
}: FloatingSelectionToolbarProps) {
  const revision = useStore(uiStore, (state) => state.revision);

  if (readOnly || !anchor.visible || selectedNodes.length === 0) return null;

  const primary = selectedNodes[0]!;
  const ids = selectedNodes.map((node) => node.id);
  const showFill = selectedNodes.some(
    (node) =>
      node.type === "rect" || node.type === "ellipse" || node.type === "note" || node.type === "frame",
  );
  const showStroke = selectedNodes.some((node) => node.type !== "note");
  const showFont = selectedNodes.some((node) => node.type === "text" || node.type === "note");
  const showConnector = selectedNodes.some((node) => node.type === "connector");

  const apply = (patch: Parameters<CanvasController["patchNodes"]>[1]): void => {
    controller?.patchNodes(ids, patch);
  };

  return (
    <div
      className="floating-toolbar glass-panel"
      style={{ left: `${anchor.x}px`, top: `${anchor.y - 12}px` }}
      role="toolbar"
      aria-label="Selection controls"
      data-revision={revision}
    >
      {showFill ? (
        <>
          <div className="floating-toolbar-swatches">
            {FILL_SWATCHES.slice(0, 6).map((swatch) => (
              <button
                key={swatch.value}
                type="button"
                className={`floating-toolbar-swatch ${primary.fill === swatch.value ? "active" : ""}`}
                style={{ background: swatch.value }}
                title={swatch.name}
                aria-label={`Fill ${swatch.name}`}
                onClick={() => apply({ fill: swatch.value })}
              />
            ))}
          </div>
          <span className="floating-toolbar-divider" />
        </>
      ) : null}

      {showStroke ? (
        <>
          <label className="floating-toolbar-button" title="Stroke width">
            <span aria-hidden="true">╱</span>
            <input
              className="floating-toolbar-slider"
              type="range"
              min={0}
              max={12}
              step={1}
              value={primary.strokeWidth}
              aria-label="Stroke width"
              onChange={(event) => apply({ strokeWidth: Number(event.target.value) })}
            />
          </label>
          <span className="floating-toolbar-divider" />
        </>
      ) : null}

      <label className="floating-toolbar-button" title="Opacity">
        <span aria-hidden="true">◐</span>
        <input
          className="floating-toolbar-slider"
          type="range"
          min={10}
          max={100}
          step={5}
          value={Math.round((primary.opacity ?? 1) * 100)}
          aria-label="Opacity"
          onChange={(event) => apply({ opacity: Number(event.target.value) / 100 })}
        />
      </label>

      {showFont ? (
        <>
          <span className="floating-toolbar-divider" />
          <button
            type="button"
            className="floating-toolbar-button"
            title="Decrease font size"
            aria-label="Decrease font size"
            onClick={() => apply({ fontSize: Math.max(8, primary.fontSize - 2) })}
          >
            A−
          </button>
          <button
            type="button"
            className="floating-toolbar-button"
            title="Increase font size"
            aria-label="Increase font size"
            onClick={() => apply({ fontSize: Math.min(160, primary.fontSize + 2) })}
          >
            A+
          </button>
        </>
      ) : null}

      {showConnector ? (
        <>
          <span className="floating-toolbar-divider" />
          {(["straight", "curved", "orthogonal"] as CurveType[]).map((curve) => (
            <button
              key={curve}
              type="button"
              className="floating-toolbar-button"
              title={`${curve} connector`}
              aria-label={`${curve} connector`}
              aria-pressed={primary.curveType === curve}
              onClick={() => apply({ curveType: curve })}
            >
              {curve === "straight" ? "↗" : curve === "curved" ? "⌒" : "⌐"}
            </button>
          ))}
        </>
      ) : null}

      <span className="floating-toolbar-divider" />

      <button
        type="button"
        className="floating-toolbar-button"
        title="Bring to front"
        aria-label="Bring to front"
        onClick={() => controller?.bringToFront(ids)}
      >
        ↑
      </button>
      <button
        type="button"
        className="floating-toolbar-button"
        title="Send to back"
        aria-label="Send to back"
        onClick={() => controller?.sendToBack(ids)}
      >
        ↓
      </button>
      <button
        type="button"
        className="floating-toolbar-button"
        title="AI actions (Cmd/Ctrl+J)"
        aria-label="AI actions"
        onClick={onOpenAi}
      >
        ✦
      </button>
      <button
        type="button"
        className="floating-toolbar-button danger"
        title="Delete"
        aria-label="Delete selection"
        onClick={() => controller?.deleteSelection()}
      >
        ✕
      </button>
    </div>
  );
}
