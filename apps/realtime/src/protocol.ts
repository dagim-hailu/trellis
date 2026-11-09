import {
  CLOSE_CODE,
  MAX_AWARENESS_BYTES,
  MAX_SYNC_CONTROL_BYTES,
  WS_MESSAGE,
} from "@trellis/shared";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";
import type { Awareness } from "y-protocols/awareness";

const MAX_AWARENESS_CLIENTS = 512;

export type SyncUpdateKind = "sync-step-2" | "update";

export type ClientFrame =
  | { type: "sync-step-1"; stateVector: Uint8Array }
  | { type: "sync-update"; subtype: SyncUpdateKind; update: Uint8Array }
  | { type: "awareness"; update: Uint8Array; clientIds: number[] }
  | { type: "query-awareness" };

export class ProtocolViolation extends Error {
  readonly closeCode: number;

  constructor(message: string, closeCode = CLOSE_CODE.INVALID_FRAME) {
    super(message);
    this.name = "ProtocolViolation";
    this.closeCode = closeCode;
  }
}

export function parseClientFrame(data: Uint8Array, maxUpdateBytes: number): ClientFrame {
  if (data.byteLength === 0) throw new ProtocolViolation("Empty WebSocket frame");

  try {
    const decoder = decoding.createDecoder(data);
    const messageType = decoding.readVarUint(decoder);

    switch (messageType) {
      case WS_MESSAGE.SYNC: {
        const subtype = decoding.readVarUint(decoder);
        if (subtype === 0) {
          const stateVector = decoding.readVarUint8Array(decoder);
          if (stateVector.byteLength > MAX_SYNC_CONTROL_BYTES) {
            throw new ProtocolViolation("Sync state vector is too large");
          }
          assertFullyConsumed(decoder);
          return { type: "sync-step-1", stateVector };
        }
        if (subtype === 1 || subtype === 2) {
          const update = decoding.readVarUint8Array(decoder);
          assertUpdateSize(update, maxUpdateBytes);
          assertFullyConsumed(decoder);
          return {
            type: "sync-update",
            subtype: subtype === 1 ? "sync-step-2" : "update",
            update,
          };
        }
        throw new ProtocolViolation(`Unknown sync subtype ${subtype}`);
      }

      case WS_MESSAGE.AWARENESS: {
        const update = decoding.readVarUint8Array(decoder);
        if (update.byteLength === 0 || update.byteLength > MAX_AWARENESS_BYTES) {
          throw new ProtocolViolation("Awareness update has an invalid size");
        }
        assertFullyConsumed(decoder);
        return {
          type: "awareness",
          update,
          clientIds: decodeAwarenessClientIds(update),
        };
      }

      case WS_MESSAGE.QUERY_AWARENESS:
        assertFullyConsumed(decoder);
        return { type: "query-awareness" };

      case WS_MESSAGE.AUTH:
        throw new ProtocolViolation("AUTH frames are not accepted after the HTTP upgrade");

      default:
        throw new ProtocolViolation(`Unknown WebSocket message type ${messageType}`);
    }
  } catch (error) {
    if (error instanceof ProtocolViolation) throw error;
    throw new ProtocolViolation("Malformed Yjs protocol frame");
  }
}

export function decodeAwarenessClientIds(update: Uint8Array): number[] {
  const decoder = decoding.createDecoder(update);
  const count = decoding.readVarUint(decoder);
  if (count > MAX_AWARENESS_CLIENTS) {
    throw new ProtocolViolation("Too many awareness clients in one update");
  }

  const ids = new Set<number>();
  for (let index = 0; index < count; index += 1) {
    const clientId = decoding.readVarUint(decoder);
    const clock = decoding.readVarUint(decoder);
    if (clientId < 0 || !Number.isSafeInteger(clientId) || clock < 0) {
      throw new ProtocolViolation("Invalid awareness client id or clock");
    }
    if (ids.has(clientId)) throw new ProtocolViolation("Duplicate awareness client id");
    ids.add(clientId);
    const stateJson = decoding.readVarString(decoder);
    let state: unknown;
    try {
      state = JSON.parse(stateJson);
    } catch {
      throw new ProtocolViolation("Awareness state is not valid JSON");
    }
    if (state !== null && typeof state !== "object") {
      throw new ProtocolViolation("Awareness state must be an object or null");
    }
  }
  assertFullyConsumed(decoder);
  return Array.from(ids);
}

/**
 * Returns false for the empty Yjs update a provider sends as the sync
 * handshake. Non-empty updates are applied to a scratch document so malformed
 * data is rejected before anything is written to Postgres.
 */
export function validateUpdateForPersistence(update: Uint8Array): boolean {
  let decoded: ReturnType<typeof Y.decodeUpdate>;
  try {
    decoded = Y.decodeUpdate(update);
  } catch {
    throw new ProtocolViolation("Malformed Yjs update");
  }

  if (decoded.structs.length === 0 && decoded.ds.clients.size === 0) {
    return false;
  }

  const scratch = new Y.Doc();
  try {
    Y.applyUpdate(scratch, update, "trellis-validation");
  } catch {
    throw new ProtocolViolation("Invalid Yjs update");
  } finally {
    scratch.destroy();
  }
  return true;
}

export function encodeSyncStep1(doc: Y.Doc): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, WS_MESSAGE.SYNC);
  syncProtocol.writeSyncStep1(encoder, doc);
  return encoding.toUint8Array(encoder);
}

export function encodeSyncStep2(doc: Y.Doc, stateVector: Uint8Array): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, WS_MESSAGE.SYNC);
  syncProtocol.writeSyncStep2(encoder, doc, stateVector);
  return encoding.toUint8Array(encoder);
}

export function encodeUpdateFrame(update: Uint8Array): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, WS_MESSAGE.SYNC);
  syncProtocol.writeUpdate(encoder, update);
  return encoding.toUint8Array(encoder);
}

export function encodeAwarenessFrame(update: Uint8Array): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, WS_MESSAGE.AWARENESS);
  encoding.writeVarUint8Array(encoder, update);
  return encoding.toUint8Array(encoder);
}

export function encodeAwarenessSnapshot(awareness: Awareness): Uint8Array | null {
  const clientIds = Array.from(awareness.getStates().keys());
  if (clientIds.length === 0) return null;
  return encodeAwarenessFrame(awarenessProtocol.encodeAwarenessUpdate(awareness, clientIds));
}

export function removeAwarenessAndEncode(
  awareness: Awareness,
  clientIds: number[],
): Uint8Array | null {
  const removable = clientIds.filter((clientId) => awareness.getStates().has(clientId));
  if (removable.length === 0) return null;
  awarenessProtocol.removeAwarenessStates(awareness, removable, "disconnect");
  return awarenessProtocol.encodeAwarenessUpdate(awareness, removable, new Map());
}

export function toUint8Array(data: ArrayBuffer | Buffer | Buffer[]): Uint8Array {
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data));
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

export function truncateCloseReason(reason: string): string {
  const encoded = Buffer.from(reason, "utf8");
  if (encoded.byteLength <= 123) return reason;
  return encoded.subarray(0, 123).toString("utf8").replace(/\uFFFD$/, "");
}

function assertUpdateSize(update: Uint8Array, maxUpdateBytes: number): void {
  if (update.byteLength === 0) throw new ProtocolViolation("Empty Yjs update");
  if (update.byteLength > maxUpdateBytes) {
    throw new ProtocolViolation(`Yjs update exceeds ${maxUpdateBytes} bytes`);
  }
}

function assertFullyConsumed(decoder: decoding.Decoder): void {
  if (decoding.hasContent(decoder)) {
    throw new ProtocolViolation("Unexpected trailing bytes in protocol frame");
  }
}
