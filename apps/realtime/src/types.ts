import type { MembershipRole } from "@trellis/shared";
import type { Logger } from "pino";

export interface DocumentAccess {
  id: string;
  role: MembershipRole;
}

export interface StoredUpdate {
  id: string;
  update: Uint8Array;
}

export interface ColdStartDocument {
  snapshot: Uint8Array | null;
  throughUpdateId: string;
  updates: StoredUpdate[];
  latestUpdateId: string;
}

export interface CompactionResult {
  version: string;
  throughUpdateId: string;
  updatesRemoved: number;
}

/**
 * Structural contract for the database-backed document store. The concrete
 * implementation is PostgresDocumentStore in @trellis/db; tests can supply a
 * deterministic in-memory implementation.
 */
export interface RealtimeDocumentStore {
  getDocumentAccess(documentId: string, userId: string): Promise<DocumentAccess | null>;
  loadForColdStart(documentId: string): Promise<ColdStartDocument>;
  appendUpdate(input: {
    documentId: string;
    actorId: string;
    update: Uint8Array;
  }): Promise<{ updateId: string }>;
  compact(
    documentId: string,
    options: { retention: number },
  ): Promise<CompactionResult | null>;
}

export interface PubSub {
  subscribe(
    channel: string,
    handler: (channel: string, payload: string) => void,
  ): Promise<PubSubSubscription>;
  publish(channel: string, payload: string): Promise<void>;
  ping(): Promise<void>;
  close(): Promise<void>;
}

export interface PubSubSubscription {
  unsubscribe(): Promise<void>;
}

export interface RoomSocket {
  isOpen(): boolean;
  send(data: Uint8Array): void;
  close(code: number, reason: string): void;
}

export interface AuthenticatedActor {
  userId: string;
  displayName: string;
  role: MembershipRole;
  email: string;
  /** Epoch seconds at which the authorizing access token expires. */
  expiresAt: number;
}

export interface RealtimeRuntimeOptions {
  nodeId: string;
  channelPrefix: string;
  maxUpdateBytes: number;
  snapshotEveryUpdates: number;
  snapshotIntervalMs: number;
  snapshotRetention: number;
  store: RealtimeDocumentStore;
  pubsub: PubSub;
  logger: Logger;
}
