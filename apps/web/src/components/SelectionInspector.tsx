"use client";

import { useEffect, useMemo, useState, type RefObject } from "react";
import { useStore } from "zustand";

import { NODE_LIMITS, type CanvasNode } from "@trellis/shared";

import type { CanvasController } from "@/canvas/controller";
import type { CanvasUiStore } from "@/canvas/store";
import { FILL_SWATCHES } from "@/lib/theme-config";

interface SelectionInspectorProps {
  uiStore: CanvasUiStore;
  controllerRef: RefObject<CanvasController | null>;
  readOnly: boolean;
  onEditText: (nodeId: string, text: string) => void;
}

export function SelectionInspector({
  uiStore,
  controllerRef,
  readOnly,
  onEditText,
}: SelectionInspectorProps) {
  const selectedIds = useStore(uiStore, (state) => state.selectedNodeIds);
  const layers = useStore(uiStore, (state) => state.layers);
  const revision = useStore(uiStore, (state) => state.revision);
  void revision;
  const activeLayerId = useStore(uiStore, (state) => state.activeLayerId);
  const [layoutDirection, setLayoutDirection] = useState<"horizontal" | "vertical">("vertical");
  const [layoutGap, setLayoutGap] = useState(16);
  const [layoutPadding, setLayoutPadding] = useState(16);
  const [layoutAlignment, setLayoutAlignment] = useState<"start" | "center" | "end">("start");

  const selected = useMemo<CanvasNode[]>(() => {
    const controller = controllerRef.current;
    if (!controller) return [];
    return selectedIds
      .map((nodeId) => controller.getNode(nodeId))
      .filter((node): node is CanvasNode => node !== null);
  }, [controllerRef, revision, selectedIds]);
  const layoutFrame = selected.length === 1 && selected[0]?.type === "frame"
    ? selected[0]
    : null;

  useEffect(() => {
    if (!layoutFrame) return;
    setLayoutDirection(layoutFrame.layoutDirection ?? "vertical");
    setLayoutGap(layoutFrame.layoutGap ?? 16);
    setLayoutPadding(layoutFrame.layoutPadding ?? 16);
    setLayoutAlignment(layoutFrame.layoutAlignment ?? "start");
  }, [
    layoutFrame?.id,
    layoutFrame?.layoutAlignment,
    layoutFrame?.layoutDirection,
    layoutFrame?.layoutGap,
    layoutFrame?.layoutPadding,
  ]);

  if (selected.length === 0) {
    return (
      <section className="inspector-panel" aria-label="Selection properties">
        <div className="inspector-heading">
          <span>Selection</span>
        </div>
        <div className="inspector-empty">
          <span className="inspector-empty-icon" aria-hidden="true">◇</span>
          <p>Select an object to style it.</p>
          <small>Shift-click or drag a box to select several objects.</small>
        </div>
      </section>
    );
  }

  const first = selected[0]!;
  const textNodes = selected.filter(
    (node) => node.type === "text" || node.type === "note",
  );
  const fillableNodes = selected.filter((node) => node.type !== "text");
  const hasText = textNodes.length > 0;
  const hasFillable = fillableNodes.length > 0;
  const single = selected.length === 1 ? first : null;
  const layerIds = new Set(selected.map((node) => node.layerId));
  const commonLayer = layerIds.size === 1 ? first.layerId : "";
  const fillSource = fillableNodes[0] ?? first;
  const textSource = textNodes[0] ?? first;
  const fills = new Set(fillableNodes.map((node) => node.fill.toLowerCase()));
  const fontSizes = new Set(textNodes.map((node) => node.fontSize));
  const strokeWidths = new Set(fillableNodes.map((node) => node.strokeWidth));
  const label =
    selected.length > 1
      ? `${selected.length} objects`
      : first.type === "note"
        ? "Sticky note"
        : first.type === "text"
          ? "Text block"
          : first.type === "ellipse"
            ? "Ellipse"
            : "Rectangle";

  return (
    <section className="inspector-panel" aria-label="Selection properties">
      <div className="inspector-heading">
        <span>Selection</span>
        <span className="selection-count">{label}</span>
      </div>

      {!readOnly && hasFillable ? (
        <div className="property-group">
          <div className="property-label">
            <span>Fill</span>
            <span className="property-value">
              {fills.size === 1 ? fillSource.fill.toUpperCase() : "Mixed"}
            </span>
          </div>
          <div className="color-grid">
            {FILL_SWATCHES.map((swatch) => (
              <button
                key={swatch.value}
                type="button"
                className={`color-swatch ${fills.size === 1 && fillSource.fill.toLowerCase() === swatch.value.toLowerCase() ? "active" : ""}`}
                style={{ background: swatch.value }}
                title={`${swatch.name} · ${swatch.value}`}
                aria-label={`Set fill to ${swatch.name}`}
                onClick={() => controllerRef.current?.updateSelectedFill(swatch.value)}
              />
            ))}
            <label className="color-custom" title="Custom fill color">
              <input
                type="color"
                value={fillSource.fill}
                aria-label="Custom fill color"
                onChange={(event) => controllerRef.current?.updateSelectedFill(event.target.value)}
              />
              <span aria-hidden="true">+</span>
            </label>
          </div>
        </div>
      ) : null}

      {!readOnly && hasText ? (
        <div className="property-group">
          <div className="property-label">
            <span>Text size</span>
            <span className="property-value">
              {fontSizes.size === 1 ? `${textSource.fontSize}px` : "Mixed"}
            </span>
          </div>
          <input
            type="range"
            min={NODE_LIMITS.minFontSize}
            max={96}
            step={1}
            value={Math.min(96, textSource.fontSize)}
            aria-label="Text size"
            onChange={(event) =>
              controllerRef.current?.updateSelectedFontSize(Number(event.target.value))
            }
          />
        </div>
      ) : null}

      {!readOnly && hasFillable ? (
        <div className="property-group compact">
          <div className="property-label">
            <span>Stroke</span>
            <span className="property-value">
              {strokeWidths.size === 1 ? `${fillSource.strokeWidth}px` : "Mixed"}
            </span>
          </div>
          <input
            type="range"
            min={NODE_LIMITS.minStroke}
            max={8}
            step={1}
            value={fillSource.strokeWidth}
            aria-label="Stroke width"
            onChange={(event) =>
              controllerRef.current?.updateSelectedStrokeWidth(Number(event.target.value))
            }
          />
        </div>
      ) : null}

      {!readOnly && layers.length > 0 ? (
        <div className="property-group compact">
          <label className="property-label" htmlFor="selection-layer">
            <span>Layer</span>
          </label>
          <select
            id="selection-layer"
            value={commonLayer}
            onChange={(event) => controllerRef.current?.moveSelectionToLayer(event.target.value)}
          >
            {commonLayer === "" ? (
              <option value="" disabled>
                Mixed layers
              </option>
            ) : null}
            {[...layers].reverse().map((layer) => (
              <option key={layer.id} value={layer.id}>
                {layer.name}
              </option>
            ))}
          </select>
          <p className="property-hint">
            Active layer: <strong>{layers.find((layer) => layer.id === activeLayerId)?.name ?? "—"}</strong>
          </p>
        </div>
      ) : null}

      {!readOnly && single?.type === "frame" ? (
        <div className="property-group compact">
          <div className="property-label">
            <span>Auto layout</span>
          </div>
          <label className="layout-field">
            Direction
            <select
              value={layoutDirection}
              onChange={(event) => {
                const value = event.currentTarget.value;
                if (value === "horizontal" || value === "vertical") setLayoutDirection(value);
              }}
            >
              <option value="vertical">Vertical stack</option>
              <option value="horizontal">Horizontal row</option>
            </select>
          </label>
          <div className="layout-number-row">
            <label className="layout-field">
              Gap
              <input
                type="number"
                min={0}
                max={256}
                value={layoutGap}
                onChange={(event) => setLayoutGap(Number(event.currentTarget.value))}
              />
            </label>
            <label className="layout-field">
              Padding
              <input
                type="number"
                min={0}
                max={512}
                value={layoutPadding}
                onChange={(event) => setLayoutPadding(Number(event.currentTarget.value))}
              />
            </label>
          </div>
          <label className="layout-field">
            Alignment
            <select
              value={layoutAlignment}
              onChange={(event) => {
                const value = event.currentTarget.value;
                if (value === "start" || value === "center" || value === "end") {
                  setLayoutAlignment(value);
                }
              }}
            >
              <option value="start">Start</option>
              <option value="center">Center</option>
              <option value="end">End</option>
            </select>
          </label>
          <button
            type="button"
            className="mini-button"
            onClick={() =>
              controllerRef.current?.autoLayoutFrame(
                single.id,
                layoutDirection,
                layoutGap,
                layoutPadding,
                layoutAlignment,
              )
            }
          >
            Arrange frame contents
          </button>
          <p className="property-hint">Positions current children; it does not resize or constrain them.</p>
        </div>
      ) : null}

      <div className="property-group compact">
        <div className="property-label">
          <span>Arrange</span>
        </div>
        <div className="button-row">
          <button
            type="button"
            className="mini-button"
            disabled={readOnly}
            onClick={() => controllerRef.current?.bringSelectionToFront()}
          >
            Bring front
          </button>
          <button
            type="button"
            className="mini-button"
            disabled={readOnly}
            onClick={() => controllerRef.current?.sendSelectionToBack()}
          >
            Send back
          </button>
        </div>
      </div>

      <div className="inspector-actions">
        {single && (single.type === "text" || single.type === "note") ? (
          <button
            type="button"
            className="mini-button"
            disabled={readOnly}
            onClick={() => onEditText(single.id, single.text)}
          >
            Edit text
          </button>
        ) : null}
        <button
          type="button"
          className="mini-button"
          disabled={readOnly}
          onClick={() => controllerRef.current?.duplicateSelection()}
        >
          Duplicate
        </button>
        <button
          type="button"
          className="mini-button danger"
          disabled={readOnly}
          onClick={() => controllerRef.current?.deleteSelection()}
        >
          Delete
        </button>
      </div>
    </section>
  );
}
