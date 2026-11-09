"use client";

import { useMemo, useState } from "react";

import type { CommentDto } from "@trellis/shared";

import type { Viewport } from "@/canvas/store";

export interface CanvasCommentsProps {
  comments: readonly CommentDto[];
  viewport: Viewport;
  readOnly: boolean;
  activeCommentId: string | null;
  onSelect: (commentId: string | null) => void;
  onCreate: (x: number, y: number, content: string) => Promise<void>;
  onReply: (parentId: string, content: string) => Promise<void>;
  onToggleResolved: (commentId: string, resolved: boolean) => Promise<void>;
  /** Pending pin awaiting its first message, in world coordinates. */
  pendingPin: { x: number; y: number } | null;
  onCancelPending: () => void;
}

/**
 * Pinned canvas comments.
 *
 * Pins are positioned in screen space from their world anchor, so they track
 * pan and zoom without being part of the CRDT. Unresolved pins pulse; resolved
 * ones go quiet and grey. Threads are one level deep, which is enough for
 * "what did you mean here" without becoming a chat app.
 */
export function CanvasComments({
  comments,
  viewport,
  readOnly,
  activeCommentId,
  onSelect,
  onCreate,
  onReply,
  onToggleResolved,
  pendingPin,
  onCancelPending,
}: CanvasCommentsProps) {
  const [draft, setDraft] = useState("");
  const [replyDraft, setReplyDraft] = useState("");
  const [busy, setBusy] = useState(false);

  const roots = useMemo(() => comments.filter((comment) => !comment.parentCommentId), [comments]);
  const repliesByParent = useMemo(() => {
    const map = new Map<string, CommentDto[]>();
    for (const comment of comments) {
      if (!comment.parentCommentId) continue;
      const list = map.get(comment.parentCommentId) ?? [];
      list.push(comment);
      map.set(comment.parentCommentId, list);
    }
    return map;
  }, [comments]);

  const toScreen = (x: number, y: number): { left: number; top: number } => ({
    left: x * viewport.zoom + viewport.x,
    top: y * viewport.zoom + viewport.y,
  });

  const active = activeCommentId
    ? (comments.find((comment) => comment.id === activeCommentId) ?? null)
    : null;

  return (
    <>
      {roots.map((comment, index) => {
        const point = toScreen(comment.x, comment.y);
        return (
          <button
            key={comment.id}
            type="button"
            className={`comment-pin ${comment.resolved ? "resolved" : "unresolved"}`}
            style={{ left: `${point.left}px`, top: `${point.top}px` }}
            title={comment.content.slice(0, 80)}
            aria-label={`Comment ${index + 1}: ${comment.content.slice(0, 40)}`}
            onClick={() => onSelect(activeCommentId === comment.id ? null : comment.id)}
          >
            <span>{index + 1}</span>
          </button>
        );
      })}

      {pendingPin && !readOnly ? (
        <div
          className="comment-thread glass-panel glass-glow"
          style={{
            left: `${toScreen(pendingPin.x, pendingPin.y).left + 16}px`,
            top: `${toScreen(pendingPin.x, pendingPin.y).top + 8}px`,
          }}
        >
          <div className="comment-thread-header">
            <span className="comment-thread-author">New comment</span>
          </div>
          <div className="comment-composer">
            <input
              autoFocus
              value={draft}
              maxLength={4000}
              placeholder="What needs attention here?"
              aria-label="New comment"
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === "Escape") {
                  event.preventDefault();
                  setDraft("");
                  onCancelPending();
                  return;
                }
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  const content = draft.trim();
                  if (content.length === 0 || busy) return;
                  setBusy(true);
                  void onCreate(pendingPin.x, pendingPin.y, content)
                    .then(() => {
                      setDraft("");
                      onCancelPending();
                    })
                    .finally(() => setBusy(false));
                }
              }}
            />
          </div>
        </div>
      ) : null}

      {active ? (
        <div
          className="comment-thread glass-panel glass-glow"
          style={{
            left: `${toScreen(active.x, active.y).left + 16}px`,
            top: `${toScreen(active.x, active.y).top + 8}px`,
          }}
        >
          <div className="comment-thread-header">
            <span className="comment-thread-author">{active.authorName}</span>
            <span className="comment-thread-time">
              {new Date(active.createdAt).toLocaleString()}
            </span>
          </div>
          <div className="comment-thread-body">{active.content}</div>

          {(repliesByParent.get(active.id) ?? []).map((reply) => (
            <div key={reply.id} className="comment-reply">
              <strong>{reply.authorName}</strong> · {reply.content}
            </div>
          ))}

          {!readOnly ? (
            <>
              <div className="comment-composer">
                <input
                  value={replyDraft}
                  maxLength={4000}
                  placeholder="Reply…"
                  aria-label="Reply to comment"
                  onChange={(event) => setReplyDraft(event.target.value)}
                  onKeyDown={(event) => {
                    event.stopPropagation();
                    if (event.key !== "Enter" || event.shiftKey) return;
                    event.preventDefault();
                    const content = replyDraft.trim();
                    if (content.length === 0 || busy) return;
                    setBusy(true);
                    void onReply(active.id, content)
                      .then(() => setReplyDraft(""))
                      .finally(() => setBusy(false));
                  }}
                />
              </div>
              <div className="comment-thread-actions">
                <label className="comment-resolve">
                  <input
                    type="checkbox"
                    checked={active.resolved}
                    onChange={(event) => {
                      void onToggleResolved(active.id, event.target.checked);
                    }}
                  />
                  Resolved
                </label>
                <button
                  type="button"
                  className="button-ghost"
                  onClick={() => onSelect(null)}
                >
                  Close
                </button>
              </div>
            </>
          ) : (
            <div className="comment-thread-actions">
              <span className="comment-thread-time">
                {active.resolved ? "Resolved" : "Open"}
              </span>
              <button type="button" className="button-ghost" onClick={() => onSelect(null)}>
                Close
              </button>
            </div>
          )}
        </div>
      ) : null}
    </>
  );
}
