"use client";

import { useRef, useState, type RefObject } from "react";
import { useStore } from "zustand";

import type { CanvasController } from "@/canvas/controller";
import type { CanvasUiStore } from "@/canvas/store";

interface LayerPanelProps {
  uiStore: CanvasUiStore;
  controllerRef: RefObject<CanvasController | null>;
  readOnly: boolean;
}

export function LayerPanel({ uiStore, controllerRef, readOnly }: LayerPanelProps) {
  const layers = useStore(uiStore, (state) => state.layers);
  const activeLayerId = useStore(uiStore, (state) => state.activeLayerId);
  const [editingLayerId, setEditingLayerId] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState("");
  const skipBlurCommit = useRef(false);

  const beginRename = (layerId: string, currentName: string): void => {
    if (readOnly) return;
    skipBlurCommit.current = false;
    setEditingLayerId(layerId);
    setNameDraft(currentName);
  };

  const commitRename = (): void => {
    if (editingLayerId && !skipBlurCommit.current) {
      controllerRef.current?.renameLayer(editingLayerId, nameDraft);
    }
    skipBlurCommit.current = false;
    setEditingLayerId(null);
  };

  const displayLayers = [...layers].reverse();

  return (
    <section className="layers-panel" aria-label="Layers">
      <div className="layers-heading">
        <span>Layers</span>
        <button
          type="button"
          className="icon-button"
          onClick={() => controllerRef.current?.addLayer()}
          disabled={readOnly}
          aria-label="Add layer"
          title="Add layer"
        >
          +
        </button>
      </div>
      <div className="layer-list">
        {layers.length === 0 ? (
          <div className="muted-small">Loading layers…</div>
        ) : (
          displayLayers.map((layer) => {
            const zIndex = layers.findIndex((candidate) => candidate.id === layer.id);
            const canMoveUp = zIndex >= 0 && zIndex < layers.length - 1;
            const canMoveDown = zIndex > 0;
            const isEditing = editingLayerId === layer.id;
            return (
              <div
                key={layer.id}
                className={`layer-row ${activeLayerId === layer.id ? "active" : ""}`}
              >
                <button
                  type="button"
                  className="layer-visibility"
                  aria-label={layer.visible ? "Hide layer" : "Show layer"}
                  aria-pressed={layer.visible}
                  disabled={readOnly}
                  onClick={() => controllerRef.current?.setLayerVisibility(layer.id, !layer.visible)}
                >
                  {layer.visible ? "◉" : "○"}
                </button>
                {isEditing ? (
                  <input
                    className="layer-name-input"
                    value={nameDraft}
                    autoFocus
                    maxLength={80}
                    onChange={(event) => setNameDraft(event.target.value)}
                    onBlur={commitRename}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        commitRename();
                      } else if (event.key === "Escape") {
                        event.preventDefault();
                        skipBlurCommit.current = true;
                        setEditingLayerId(null);
                      }
                    }}
                  />
                ) : (
                  <button
                    type="button"
                    className="layer-name"
                    title="Select layer (double-click to rename)"
                    onClick={() => uiStore.getState().setActiveLayerId(layer.id)}
                    onDoubleClick={() => beginRename(layer.id, layer.name)}
                  >
                    {layer.name}
                  </button>
                )}
                <div className="layer-actions">
                  <button
                    type="button"
                    className="layer-action"
                    title="Move layer up"
                    aria-label="Move layer up"
                    disabled={readOnly || !canMoveUp}
                    onClick={() => controllerRef.current?.moveLayer(layer.id, "up")}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    className="layer-action"
                    title="Move layer down"
                    aria-label="Move layer down"
                    disabled={readOnly || !canMoveDown}
                    onClick={() => controllerRef.current?.moveLayer(layer.id, "down")}
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    className="layer-action"
                    title="Rename layer"
                    aria-label="Rename layer"
                    disabled={readOnly}
                    onClick={() => beginRename(layer.id, layer.name)}
                  >
                    ✎
                  </button>
                  <button
                    type="button"
                    className="layer-action danger"
                    title="Delete layer"
                    aria-label="Delete layer"
                    disabled={readOnly || layers.length <= 1}
                    onClick={() => controllerRef.current?.deleteLayer(layer.id)}
                  >
                    ×
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>
      <div className="layers-footnote">
        New objects go on the active layer. The top layer draws above the rest.
      </div>
    </section>
  );
}
