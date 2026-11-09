"use client";

import { useStore } from "zustand";

import type { CanvasController } from "@/canvas/controller";
import type { CanvasUiStore } from "@/canvas/store";
import type { RefObject } from "react";

interface ZoomControlsProps {
  uiStore: CanvasUiStore;
  controllerRef: RefObject<CanvasController | null>;
}

export function ZoomControls({ uiStore, controllerRef }: ZoomControlsProps) {
  const zoom = useStore(uiStore, (state) => state.viewport.zoom);

  return (
    <div className="zoom-controls" role="group" aria-label="Zoom controls">
      <button
        type="button"
        className="zoom-button"
        title="Zoom out"
        aria-label="Zoom out"
        onClick={() => controllerRef.current?.zoomOut()}
      >
        −
      </button>
      <button
        type="button"
        className="zoom-value"
        title="Reset zoom to 100%"
        aria-label={`Zoom ${Math.round(zoom * 100)} percent; reset to 100 percent`}
        onClick={() => controllerRef.current?.resetZoom()}
      >
        {Math.round(zoom * 100)}%
      </button>
      <button
        type="button"
        className="zoom-button"
        title="Zoom in"
        aria-label="Zoom in"
        onClick={() => controllerRef.current?.zoomIn()}
      >
        +
      </button>
      <span className="zoom-divider" />
      <button
        type="button"
        className="zoom-button fit"
        title="Fit all objects (Shift+1)"
        aria-label="Fit all objects"
        onClick={() => controllerRef.current?.fitToContent()}
      >
        Fit
      </button>
    </div>
  );
}
