import { z } from "zod";

/**
 * Binary frames use the canonical y-websocket/y-protocols layout:
 *   varUint messageType, followed by the y-protocols payload.
 * Authentication happens in the HTTP upgrade request, before a socket exists.
 */
export const WS_MESSAGE = {
  SYNC: 0,
  AWARENESS: 1,
  AUTH: 2,
  QUERY_AWARENESS: 3,
} as const;

export type WsMessageType = (typeof WS_MESSAGE)[keyof typeof WS_MESSAGE];

export const SYNC_MESSAGE = {
  STEP_1: 0,
  STEP_2: 1,
  UPDATE: 2,
} as const;

export const CLOSE_CODE = {
  INVALID_FRAME: 1003,
  INTERNAL_ERROR: 1011,
  SERVER_RESTART: 1012,
  TRY_AGAIN_LATER: 1013,
  GOING_AWAY: 1001,
  UNAUTHORIZED: 4401,
  FORBIDDEN: 4403,
  READ_ONLY: 4403,
  SUPERSEDED: 4409,
  SESSION_EXPIRED: 4408,
} as const;

export const MAX_AWARENESS_BYTES = 64 * 1024;
export const MAX_SYNC_CONTROL_BYTES = 256 * 1024;

export function realtimeDocumentPath(documentId: string): string {
  return `/ws/documents/${encodeURIComponent(documentId)}`;
}

export function realtimeDocumentUrl(baseUrl: string, documentId: string): string {
  const url = new URL(baseUrl);
  const basePath = url.pathname.replace(/\/$/, "");
  url.pathname = `${basePath}${realtimeDocumentPath(documentId)}`;
  return url.toString();
}

export function documentSyncChannel(prefix: string, documentId: string): string {
  assertChannelPart(prefix, "prefix");
  assertChannelPart(documentId, "documentId");
  return `${prefix}:document:${documentId}:sync`;
}

export function documentAwarenessChannel(prefix: string, documentId: string): string {
  assertChannelPart(prefix, "prefix");
  assertChannelPart(documentId, "documentId");
  return `${prefix}:document:${documentId}:awareness`;
}

function assertChannelPart(value: string, name: string): void {
  if (value.length === 0 || value.includes(":")) {
    throw new Error(`${name} must be non-empty and must not contain ':'`);
  }
}

const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const base64UpdateSchema = z
  .string()
  .min(4)
  .max(12_000_000)
  .regex(BASE64_PATTERN, "Expected base64-encoded Yjs update");
const base64AwarenessSchema = z
  .string()
  .min(4)
  .max(200_000)
  .regex(BASE64_PATTERN, "Expected base64-encoded awareness update");

const envelopeBase = {
  version: z.literal(1),
  documentId: z.string().uuid(),
  originNodeId: z.string().min(1).max(128),
  publishedAt: z.number().int().nonnegative(),
} as const;

export const redisUpdateEnvelopeSchema = z.object({
  ...envelopeBase,
  kind: z.literal("update"),
  updateId: z.string().regex(/^\d+$/),
  actorId: z.string().uuid(),
  update: base64UpdateSchema,
});

export const redisAwarenessEnvelopeSchema = z.object({
  ...envelopeBase,
  kind: z.literal("awareness"),
  awareness: base64AwarenessSchema,
});

/**
 * Sent when a room opens on a node. Peer nodes answer through the same
 * awareness channel with their locally-owned presence states. This avoids
 * waiting up to 15 seconds for the next provider awareness heartbeat before
 * showing peers that connected through another Node process.
 */
export const redisAwarenessSyncRequestEnvelopeSchema = z.object({
  ...envelopeBase,
  kind: z.literal("awareness-sync-request"),
});

export const redisEnvelopeSchema = z.discriminatedUnion("kind", [
  redisUpdateEnvelopeSchema,
  redisAwarenessEnvelopeSchema,
  redisAwarenessSyncRequestEnvelopeSchema,
]);

export type RedisUpdateEnvelope = z.infer<typeof redisUpdateEnvelopeSchema>;
export type RedisAwarenessEnvelope = z.infer<typeof redisAwarenessEnvelopeSchema>;
export type RedisAwarenessSyncRequestEnvelope = z.infer<
  typeof redisAwarenessSyncRequestEnvelopeSchema
>;
export type RedisEnvelope = z.infer<typeof redisEnvelopeSchema>;

export interface PresenceUser {
  id: string;
  name: string;
  color: string;
}

/** Maximum length of an ephemeral cursor-chat message, in characters. */
export const MAX_CHAT_TEXT_LENGTH = 120;

/**
 * Ephemeral presence. Never persisted: awareness frames are validated, relayed
 * and dropped. `chatText` and `followingUserId` exist purely so the canvas can
 * render a floating chat bubble and a follow-mode indicator.
 */
export interface PresenceState {
  user: PresenceUser;
  cursor: { x: number; y: number } | null;
  selection: string[];
  /** Cursor-chat message. Null or absent when the user is not chatting. */
  chatText?: string | null;
  /** Epoch ms after which chatText should be ignored by receivers. */
  chatActiveUntil?: number | null;
  /** User id this client's viewport is following, or null when not following. */
  followingUserId?: string | null;
}

/**
 * Truncate cursor-chat text to the wire limit.
 *
 * Truncation rather than rejection is deliberate: a slightly long chat message
 * should still appear (clipped) instead of costing the sender their whole
 * awareness frame, which also carries their cursor and selection.
 */
export function sanitizeChatText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.replace(/[\r\n]+/g, " ").trim();
  if (trimmed.length === 0) return null;
  return trimmed.slice(0, MAX_CHAT_TEXT_LENGTH);
}
