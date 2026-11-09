"use client";

import { useState } from "react";

export type AiAction = "mind-map" | "arrange" | "summarize";

export interface AiPromptModalProps {
  open: boolean;
  onClose: () => void;
  onRun: (action: AiAction, topic: string) => Promise<string>;
  providerName: string;
  hasSelection: boolean;
}

/**
 * AI co-designer prompt (Cmd/Ctrl+J).
 *
 * Three actions, each with a clear contract: generate a mind map from a topic,
 * auto-arrange the current selection, or summarize the selected notes. The
 * provider name is shown so it is obvious whether results came from a configured
 * endpoint or the built-in offline provider.
 */
export function AiPromptModal({
  open,
  onClose,
  onRun,
  providerName,
  hasSelection,
}: AiPromptModalProps) {
  const [action, setAction] = useState<AiAction>("mind-map");
  const [topic, setTopic] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  if (!open) return null;

  const run = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const result = await onRun(action, topic);
      setMessage(result);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The AI action failed.");
    } finally {
      setBusy(false);
    }
  };

  const needsTopic = action === "mind-map";
  const needsSelection = action !== "mind-map";
  const disabled = busy || (needsTopic && topic.trim().length === 0) || (needsSelection && !hasSelection);

  return (
    <div
      className="palette-scrim"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target) onClose();
      }}
    >
      <div className="ai-modal glass-panel glass-glow" role="dialog" aria-modal="true" aria-label="AI co-designer">
        <h2>AI co-designer</h2>
        <p>
          Runs on the <strong>{providerName}</strong> provider. Every result is written as a
          normal edit, so you can undo it.
        </p>

        <div className="ai-action-row">
          {(
            [
              { id: "mind-map", label: "Mind map" },
              { id: "arrange", label: "Auto-arrange" },
              { id: "summarize", label: "Summarize notes" },
            ] as Array<{ id: AiAction; label: string }>
          ).map((option) => (
            <button
              key={option.id}
              type="button"
              className={`ai-action-chip ${action === option.id ? "active" : ""}`}
              aria-pressed={action === option.id}
              onClick={() => {
                setAction(option.id);
                setMessage(null);
              }}
            >
              {option.label}
            </button>
          ))}
        </div>

        {needsTopic ? (
          <textarea
            value={topic}
            placeholder="What should the mind map be about?"
            aria-label="Mind map topic"
            onChange={(event) => setTopic(event.target.value)}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === "Escape") onClose();
            }}
          />
        ) : (
          <p className="ai-modal-note">
            {hasSelection
              ? "Uses the current selection."
              : "Select some notes on the canvas first."}
          </p>
        )}

        {message ? <p className="ai-modal-note">{message}</p> : null}

        <div className="ai-modal-actions">
          <span className="ai-modal-note">⌘/Ctrl + J</span>
          <span className="spacer" />
          <button type="button" className="button-ghost" onClick={onClose}>
            Close
          </button>
          <button
            type="button"
            className="button-primary"
            disabled={disabled}
            onClick={() => void run()}
          >
            {busy ? "Working…" : "Run"}
          </button>
        </div>
      </div>
    </div>
  );
}
