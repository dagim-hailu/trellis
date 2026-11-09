"use client";

import { useMemo, useState } from "react";

import type { CanvasComponent, CanvasNode, CommentDto } from "@trellis/shared";

interface CanvasToolsDialogProps {
  open: boolean;
  components: CanvasComponent[];
  nodes: CanvasNode[];
  comments: CommentDto[];
  selectedCount: number;
  canEdit: boolean;
  onClose: () => void;
  onCreateComponent: (name: string) => boolean;
  onInsertComponent: (id: string) => void;
  onSelectNode: (id: string) => void;
  onReviewComment: (id: string) => void;
}

export function CanvasToolsDialog({
  open,
  components,
  nodes,
  comments,
  selectedCount,
  canEdit,
  onClose,
  onCreateComponent,
  onInsertComponent,
  onSelectNode,
  onReviewComment,
}: CanvasToolsDialogProps) {
  const [name, setName] = useState("");
  const [componentError, setComponentError] = useState<string | null>(null);

  const checks = useMemo(() => {
    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    const missingImages = nodes.filter(
      (node) => node.type === "image" && !node.assetId && !node.url,
    );
    const smallText = nodes.filter(
      (node) => (node.type === "text" || node.type === "note" || node.text.length > 0) &&
        node.text.trim().length > 0 &&
        node.fontSize < 12,
    );
    const outsideFrames = nodes.filter((node) => {
      if (!node.parentFrameId) return false;
      const frame = nodeById.get(node.parentFrameId);
      if (!frame || frame.type !== "frame") return false;
      return (
        node.x < frame.x ||
        node.y < frame.y ||
        node.x + node.width > frame.x + frame.width ||
        node.y + node.height > frame.y + frame.height
      );
    });
    const unresolved = comments.filter((comment) => !comment.resolved);
    return { missingImages, smallText, outsideFrames, unresolved };
  }, [comments, nodes]);

  if (!open) return null;

  const createComponent = (): void => {
    if (!name.trim()) {
      setComponentError("Add a name for this component.");
      return;
    }
    if (!onCreateComponent(name)) {
      setComponentError("Select unlinked objects to create a component.");
      return;
    }
    setName("");
    setComponentError(null);
  };

  return (
    <div
      className="palette-scrim asset-dialog-scrim"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target) onClose();
      }}
    >
      <section
        className="asset-dialog canvas-tools-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="canvas-tools-title"
        onKeyDown={(event) => {
          if (event.key === "Escape") onClose();
        }}
      >
        <header className="asset-dialog-header">
          <div>
            <p className="eyebrow">Canvas Compass</p>
            <h2 id="canvas-tools-title">Reusable pieces and preflight</h2>
            <p>Keep useful patterns close and catch practical issues before sharing.</p>
          </div>
          <button type="button" className="button-ghost" onClick={onClose}>Close</button>
        </header>

        <div className="canvas-tools-grid">
          <section className="canvas-tools-section" aria-labelledby="components-heading">
            <div className="canvas-tools-section-heading">
              <div>
                <h3 id="components-heading">Components</h3>
                <p>Reusable within this document. Style edits stay linked.</p>
              </div>
              <span className="selection-count">{components.length}</span>
            </div>
            {canEdit ? (
              <form
                className="component-create-row"
                onSubmit={(event) => {
                  event.preventDefault();
                  createComponent();
                }}
              >
                <label className="visually-hidden" htmlFor="component-name">Component name</label>
                <input
                  id="component-name"
                  value={name}
                  maxLength={80}
                  placeholder={selectedCount > 0 ? `Name ${selectedCount} selected object${selectedCount === 1 ? "" : "s"}` : "Select objects, then name"}
                  onChange={(event) => {
                    setName(event.currentTarget.value);
                    setComponentError(null);
                  }}
                />
                <button className="mini-button" type="submit" disabled={selectedCount === 0}>
                  Create
                </button>
              </form>
            ) : (
              <p className="asset-dialog-note">Viewers can browse and insert components.</p>
            )}
            {componentError ? <p className="form-error" role="alert">{componentError}</p> : null}
            {components.length === 0 ? (
              <p className="asset-dialog-note">Select one or more objects to make your first reusable piece.</p>
            ) : (
              <ul className="canvas-component-list">
                {components.map((component) => (
                  <li key={component.id}>
                    <span>
                      <strong>{component.name}</strong>
                      <small>{component.nodeIds.length} source object{component.nodeIds.length === 1 ? "" : "s"}</small>
                    </span>
                    <button
                      type="button"
                      className="mini-button"
                      disabled={!canEdit}
                      onClick={() => onInsertComponent(component.id)}
                    >
                      Insert
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="canvas-tools-section compass-section" aria-labelledby="compass-heading">
            <div className="canvas-tools-section-heading">
              <div>
                <h3 id="compass-heading">Preflight checks</h3>
                <p>Local checks only; your canvas content is not sent anywhere.</p>
              </div>
            </div>
            <ul className="compass-check-list">
              <CheckRow
                label="Image sources"
                count={checks.missingImages.length}
                detail="Images without an asset or URL"
                action={checks.missingImages[0] ? () => onSelectNode(checks.missingImages[0]!.id) : undefined}
                actionLabel="Select image"
              />
              <CheckRow
                label="Text size"
                count={checks.smallText.length}
                detail="Text smaller than 12 px"
                action={checks.smallText[0] ? () => onSelectNode(checks.smallText[0]!.id) : undefined}
                actionLabel="Select text"
              />
              <CheckRow
                label="Frame bounds"
                count={checks.outsideFrames.length}
                detail="Children extending beyond their frame"
                action={checks.outsideFrames[0] ? () => onSelectNode(checks.outsideFrames[0]!.id) : undefined}
                actionLabel="Select object"
              />
              <CheckRow
                label="Review comments"
                count={checks.unresolved.length}
                detail="Unresolved discussion threads"
                action={checks.unresolved[0] ? () => onReviewComment(checks.unresolved[0]!.id) : undefined}
                actionLabel="Review"
              />
            </ul>
            <p className="compass-footnote">
              These are suggestions, not blockers. Fixes remain under your control.
            </p>
          </section>
        </div>
      </section>
    </div>
  );
}

function CheckRow({
  label,
  count,
  detail,
  action,
  actionLabel,
}: {
  label: string;
  count: number;
  detail: string;
  action?: (() => void) | undefined;
  actionLabel: string;
}) {
  return (
    <li className="compass-check-row">
      <span className={`compass-check-icon ${count === 0 ? "clear" : "needs-attention"}`} aria-hidden="true">
        {count === 0 ? "✓" : "!"}
      </span>
      <span className="compass-check-copy">
        <strong>{label}{count > 0 ? ` · ${count}` : ""}</strong>
        <small>{detail}</small>
      </span>
      {action ? (
        <button type="button" className="mini-button" onClick={action}>{actionLabel}</button>
      ) : (
        <span className="compass-clear-label">{count === 0 ? "Clear" : "Review"}</span>
      )}
    </li>
  );
}
