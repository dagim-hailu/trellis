"use client";

import { useEffect, useLayoutEffect, useRef } from "react";

import type { CanvasNode } from "@trellis/shared";

import type { Viewport } from "@/canvas/store";

export interface InPlaceTextEditorProps {
  node: CanvasNode;
  value: string;
  viewport: Viewport;
  onChange: (value: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}

/**
 * In-place canvas text editing.
 *
 * A borderless textarea is positioned exactly over the node and transformed
 * with the same translate/scale as the canvas, so the text the user types sits
 * where the painted text was. The font size is divided by zoom because the
 * textarea lives in screen space while the node's font size is in world units.
 *
 * This replaces the previous modal dialog: editing a sticky note in a modal
 * means you cannot see the note's context, which defeats the point of a canvas.
 */
export function InPlaceTextEditor({
  node,
  value,
  viewport,
  onChange,
  onCommit,
  onCancel,
}: InPlaceTextEditorProps) {
  const ref = useRef<HTMLTextAreaElement | null>(null);

  useLayoutEffect(() => {
    const field = ref.current;
    if (!field) return;
    field.focus();
    // Place the caret at the end rather than selecting everything: a
    // double-click-to-edit should append, not silently replace existing text.
    const length = field.value.length;
    field.setSelectionRange(length, length);
  }, []);

  // Auto-resize to the content so the box never clips a wrapped line.
  useEffect(() => {
    const field = ref.current;
    if (!field) return;
    field.style.height = "auto";
    field.style.height = `${field.scrollHeight}px`;
  }, [value, viewport.zoom]);

  const zoom = viewport.zoom;
  const isNote = node.type === "note";
  const padding = isNote ? 18 : 12;

  return (
    <textarea
      ref={ref}
      className="canvas-inline-editor"
      value={value}
      spellCheck
      aria-label={isNote ? "Edit sticky note" : "Edit text"}
      style={{
        left: `${node.x * zoom + viewport.x + padding * zoom}px`,
        top: `${node.y * zoom + viewport.y + padding * zoom}px`,
        width: `${Math.max(40, (node.width - padding * 2) * zoom)}px`,
        minHeight: `${Math.max(20, (node.height - padding * 2) * zoom)}px`,
        fontSize: `${node.fontSize * zoom}px`,
        lineHeight: 1.35,
        fontWeight: isNote ? 600 : 500,
      }}
      onChange={(event) => onChange(event.target.value)}
      onBlur={onCommit}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape") {
          event.preventDefault();
          onCancel();
          return;
        }
        // Enter inserts a newline; Cmd/Ctrl+Enter commits, matching the
        // convention used everywhere else in the app.
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          onCommit();
        }
      }}
    />
  );
}
