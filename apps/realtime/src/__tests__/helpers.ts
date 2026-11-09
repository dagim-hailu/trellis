import * as Y from "yjs";
import pino from "pino";

import type { MembershipRole } from "@trellis/shared";
import type {
  ColdStartDocument,
  CompactionResult,
  DocumentAccess,
  PubSub,
  PubSubSubscription,
  RealtimeDocumentStore,
  RealtimeRuntimeOptions,
  RoomSocket,
} from "../types.js";

export const DOCUMENT_ID = "b4f2b9c9-2a46-4b0e-b6f6-645c8a673c74";
export const USER_ID = "7f518c2d-66b3-4906-8c87-1d54f9d29a03";
export const SECOND_USER_ID = "b73ed6b7-1ca2-4b07-9f36-5712c5a2a562";
export const THIRD_USER_ID = "401bd5c8-1a6e-4df9-a1fa-c61d688c75ed";
export const TEST_SECRET = "a-realtime-test-secret-with-at-least-32-characters";

export const logger = pino({ level: "silent" });

export function actorFor(
  userId: string,
  role: MembershipRole,
  displayName = "Test User",
  expiresAt = Math.floor(Date.now() / 1000) + 3600,
): {
  userId: string;
  displayName: string;
  email: string;
  role: MembershipRole;
  expiresAt: number;
} {
  return { userId, displayName, email: `${userId}@example.test`, role, expiresAt };
}

export class FakeSocket implements RoomSocket {
  readonly frames: Uint8Array[] = [];
  readonly closeCode: number[] = [];
  readonly closeReason: string[] = [];
  open = true;

  isOpen(): boolean {
    return this.open;
  }

  send(data: Uint8Array): void {
    if (!this.open) throw new Error("socket is closed");
    this.frames.push(Uint8Array.from(data));
  }

  close(code: number, reason: string): void {
    this.closeCode.push(code);
    this.closeReason.push(reason);
    this.open = false;
  }
}

interface BusSubscriber {
  id: string;
  channel: string;
  handler: (channel: string, payload: string) => void;
}

/**
 * A deliberately hostile Pub/Sub bus: it delivers messages to the publisher's
 * own subscriber too. Real Redis does not do that. This lets the tests verify
 * both cross-node fan-out and the defensive origin-node echo guard.
 */
export class FakeBus {
  private readonly subscribers = new Map<string, BusSubscriber[]>();
  private nextId = 1;
  readonly published: Array<{ channel: string; payload: string; publisherId: string }> = [];

  add(nodeId: string, channel: string, handler: (channel: string, payload: string) => void): string {
    const id = `${nodeId}-${this.nextId++}`;
    const list = this.subscribers.get(channel) ?? [];
    list.push({ id, channel, handler });
    this.subscribers.set(channel, list);
    return id;
  }

  remove(id: string): void {
    for (const [channel, list] of this.subscribers) {
      const filtered = list.filter((entry) => entry.id !== id);
      if (filtered.length === 0) this.subscribers.delete(channel);
      else this.subscribers.set(channel, filtered);
    }
  }

  publish(nodeId: string, channel: string, payload: string): void {
    this.published.push({ channel, payload, publisherId: nodeId });
    const targets = [...(this.subscribers.get(channel) ?? [])];
    queueMicrotask(() => {
      for (const target of targets) {
        target.handler(channel, payload);
      }
    });
  }

  subscriberCount(channel?: string): number {
    if (channel) return this.subscribers.get(channel)?.length ?? 0;
    let count = 0;
    for (const list of this.subscribers.values()) count += list.length;
    return count;
  }
}

export class FakePubSub implements PubSub {
  readonly subscriptions = new Map<string, string>();

  constructor(
    private readonly bus: FakeBus,
    private readonly nodeId: string,
  ) {}

  async subscribe(
    channel: string,
    handler: (channel: string, payload: string) => void,
  ): Promise<PubSubSubscription> {
    const id = this.bus.add(this.nodeId, channel, handler);
    this.subscriptions.set(channel, id);
    return {
      unsubscribe: async () => {
        this.bus.remove(id);
        this.subscriptions.delete(channel);
      },
    };
  }

  async publish(channel: string, payload: string): Promise<void> {
    this.bus.publish(this.nodeId, channel, payload);
    // Let queued fan-out run before persistence callers continue.
    await Promise.resolve();
    await Promise.resolve();
  }

  async ping(): Promise<void> {
    return;
  }

  async close(): Promise<void> {
    for (const id of this.subscriptions.values()) this.bus.remove(id);
    this.subscriptions.clear();
  }

  get channelCount(): number {
    return this.subscriptions.size;
  }
}

interface StoredRow {
  id: string;
  update: Uint8Array;
}

interface FakeDocument {
  snapshot: Uint8Array | null;
  updates: StoredRow[];
  nextUpdateId: bigint;
}

export class FakeDocumentStore implements RealtimeDocumentStore {
  private readonly documents = new Map<string, FakeDocument>();
  private readonly access = new Map<string, Map<string, MembershipRole>>();
  readonly appendCalls: Array<{ documentId: string; actorId: string; bytes: number }> = [];
  readonly compactionCalls: string[] = [];
  readonly loadCalls: string[] = [];

  grantAccess(documentId: string, userId: string, role: MembershipRole): void {
    const documentAccess = this.access.get(documentId) ?? new Map<string, MembershipRole>();
    documentAccess.set(userId, role);
    this.access.set(documentId, documentAccess);
  }

  async getDocumentAccess(documentId: string, userId: string): Promise<DocumentAccess | null> {
    const role = this.access.get(documentId)?.get(userId);
    return role ? { id: documentId, role } : null;
  }

  async loadForColdStart(documentId: string): Promise<ColdStartDocument> {
    this.loadCalls.push(documentId);
    const document = this.documents.get(documentId);
    if (!document) {
      return {
        snapshot: null,
        throughUpdateId: "0",
        updates: [],
        latestUpdateId: "0",
      };
    }
    return {
      snapshot: document.snapshot,
      throughUpdateId: "0",
      updates: document.updates.map((row) => ({ id: row.id, update: row.update })),
      latestUpdateId: document.updates.at(-1)?.id ?? "0",
    };
  }

  async appendUpdate(input: {
    documentId: string;
    actorId: string;
    update: Uint8Array;
  }): Promise<{ updateId: string }> {
    const document = this.getOrCreateDocument(input.documentId);
    document.nextUpdateId += 1n;
    const id = document.nextUpdateId.toString();
    document.updates.push({ id, update: Uint8Array.from(input.update) });
    this.appendCalls.push({
      documentId: input.documentId,
      actorId: input.actorId,
      bytes: input.update.byteLength,
    });
    return { updateId: id };
  }

  async compact(
    documentId: string,
    _options: { retention: number },
  ): Promise<CompactionResult | null> {
    this.compactionCalls.push(documentId);
    const document = this.documents.get(documentId);
    if (!document || document.updates.length === 0) return null;

    const yDoc = new Y.Doc();
    try {
      if (document.snapshot) Y.applyUpdate(yDoc, document.snapshot);
      for (const row of document.updates) Y.applyUpdate(yDoc, row.update);
      const state = Y.encodeStateAsUpdate(yDoc);
      const throughUpdateId = document.updates.at(-1)?.id ?? "0";
      document.snapshot = state;
      document.updates = [];
      return {
        version: "1",
        throughUpdateId,
        updatesRemoved: 1,
      };
    } finally {
      yDoc.destroy();
    }
  }

  seedUpdate(documentId: string, update: Uint8Array): void {
    const document = this.getOrCreateDocument(documentId);
    document.nextUpdateId += 1n;
    document.updates.push({ id: document.nextUpdateId.toString(), update: Uint8Array.from(update) });
  }

  private getOrCreateDocument(documentId: string): FakeDocument {
    let document = this.documents.get(documentId);
    if (!document) {
      document = { snapshot: null, updates: [], nextUpdateId: 0n };
      this.documents.set(documentId, document);
    }
    return document;
  }
}

export function runtimeOptions(
  store: FakeDocumentStore,
  pubsub: FakePubSub,
  overrides: Partial<RealtimeRuntimeOptions> = {},
): RealtimeRuntimeOptions {
  return {
    nodeId: "node-a",
    channelPrefix: "test",
    maxUpdateBytes: 1_048_576,
    snapshotEveryUpdates: 10_000,
    snapshotIntervalMs: 60_000,
    snapshotRetention: 5,
    store,
    pubsub,
    logger,
    ...overrides,
  };
}
