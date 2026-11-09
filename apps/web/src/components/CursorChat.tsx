"use client";

import { useEffect, useRef, useState } from "react";

import { MAX_CHAT_TEXT_LENGTH } from "@trellis/shared";

export interface CursorChatProps {
  open: boolean;
  /** Screen position of the local pointer, where the input is anchored. */
  anchor: { x: number; y: number } | null;
  onSend: (text: string) => void;
  onClose: () => void;
}

/**
 * Cursor chat: press `/` and type a message that appears as a floating glass
 * pill under your pointer for everyone in the room.
 *
 * The message is ephemeral. It travels over awareness, never Postgres, and
 * expires on its own, so nothing about a quick "look here" survives the session.
 */
export function CursorChat({ open, anchor, onSend, onClose }: CursorChatProps) {
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) {
      setValue("");
      return;
    }
    const timer = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [open]);

  if (!open || !anchor) return null;

  const commit = (): void => {
    const trimmed = value.trim();
    if (trimmed.length > 0) onSend(trimmed.slice(0, MAX_CHAT_TEXT_LENGTH));
    onClose();
  };

  return (
    <div
      className="cursor-chat-input glass-panel"
      style={{ left: `${anchor.x + 14}px`, top: `${anchor.y + 18}px` }}
    >
      <input
        ref={inputRef}
        value={value}
        maxLength={MAX_CHAT_TEXT_LENGTH}
        placeholder="Say something…"
        aria-label="Cursor chat message"
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Escape") {
            event.preventDefault();
            onClose();
            return;
          }
          if (event.key === "Enter") {
            event.preventDefault();
            commit();
          }
        }}
        onBlur={commit}
      />
      <span className="cursor-chat-count">
        {value.length}/{MAX_CHAT_TEXT_LENGTH}
      </span>
    </div>
  );
}
