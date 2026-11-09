"use client";

import { useStore } from "zustand";

import type { CanvasUiStore } from "@/canvas/store";
import type { RemotePresence } from "@/canvas/renderer";
import { contrastText } from "@/lib/theme-config";

export interface PresenceBarProps {
  uiStore: CanvasUiStore;
  peers: readonly RemotePresence[];
  onFollow: (userId: string | null) => void;
}

/**
 * Avatar stack in the header. Clicking an avatar enters follow mode, which
 * interpolates the local viewport toward that user's cursor.
 *
 * Following is a local view state only: it is never written to the document and
 * never broadcast, because it changes nothing other users can observe.
 */
export function PresenceBar({ uiStore, peers, onFollow }: PresenceBarProps) {
  const followUserId = useStore(uiStore, (state) => state.followUserId);

  if (peers.length === 0) {
    return <span className="presence-count">Just you</span>;
  }

  const followed = peers.find((peer) => peer.userId === followUserId) ?? null;

  return (
    <>
      <div className="presence-bar" role="group" aria-label="People in this canvas">
        {peers.slice(0, 6).map((peer) => {
          const initials = peer.name
            .split(/\s+/)
            .map((part) => part[0] ?? "")
            .join("")
            .slice(0, 2)
            .toUpperCase();
          const isFollowing = followUserId === peer.userId;
          return (
            <button
              key={peer.clientId}
              type="button"
              className={`presence-avatar ${isFollowing ? "following" : ""}`}
              style={{ background: peer.color, color: contrastText(peer.color) }}
              title={isFollowing ? `Stop following ${peer.name}` : `Follow ${peer.name}`}
              aria-label={isFollowing ? `Stop following ${peer.name}` : `Follow ${peer.name}`}
              aria-pressed={isFollowing}
              onClick={() => onFollow(isFollowing ? null : peer.userId)}
            >
              {initials || "?"}
            </button>
          );
        })}
        {peers.length > 6 ? <span className="presence-count">+{peers.length - 6}</span> : null}
      </div>

      {followed ? (
        <div className="presence-follow-banner glass-panel">
          <span>Following {followed.name}</span>
          <button type="button" className="button-ghost" onClick={() => onFollow(null)}>
            Stop
          </button>
        </div>
      ) : null}
    </>
  );
}
