import { randomUUID } from "node:crypto";

import {
  CLOSE_CODE,
  MAX_CHAT_TEXT_LENGTH,
  canEdit,
  documentAwarenessChannel,
  documentSyncChannel,
  redisEnvelopeSchema,
  type MembershipRole,
  type RedisAwarenessEnvelope,
  type RedisEnvelope,
  type RedisUpdateEnvelope,
} from "@trellis/shared";
import * as awarenessProtocol from "y-protocols/awareness";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import type { Logger } from "pino";

import {
  ProtocolViolation,
  encodeAwarenessFrame,
  encodeAwarenessSnapshot,
  encodeSyncStep1,
  encodeSyncStep2,
  encodeUpdateFrame,
  parseClientFrame,
  removeAwarenessAndEncode,
  truncateCloseReason,
  validateUpdateForPersistence,
} from "./protocol.js";
import type {
  AuthenticatedActor,
  PubSub,
  PubSubSubscription,
  RealtimeDocumentStore,
  RealtimeRuntimeOptions,
  RoomSocket,
} from "./types.js";

const PERSISTED_ORIGIN = "trellis-persisted-update";
const REDIS_ORIGIN = "trellis-redis-update";
const MAX_PENDING_WRITES = 500;
const MAX_QUEUED_ENVELOPES = 10_000;

/** How often the room checks connected sockets for expired sessions. */
const SESSION_SWEEP_INTERVAL_MS = 30_000;

/**
 * Awareness flood control. A legitimate client sends roughly one awareness
 * frame per animation frame while moving (about 60/s), so the bucket is sized
 * to admit that comfortably and to reject a script that tries thousands.
 */
const AWARENESS_BUCKET_CAPACITY = 90;
const AWARENESS_REFILL_PER_SECOND = 60;

/**
 * Token bucket for awareness frames.
 *
 * Over-limit frames are dropped, not fatal. Closing the socket would let a
 * malicious or buggy client take itself offline and immediately reconnect,
 * which costs the server more than simply ignoring the excess frames.
 */
export class AwarenessRateLimiter {
  private tokens: number;
  private lastRefillMs: number;
  private dropped = 0;

  constructor(
    private readonly capacity = AWARENESS_BUCKET_CAPACITY,
    private readonly refillPerSecond = AWARENESS_REFILL_PER_SECOND,
    now: number = Date.now(),
  ) {
    this.tokens = capacity;
    this.lastRefillMs = now;
  }

  get droppedCount(): number {
    return this.dropped;
  }

  /** Returns true when the frame may be processed. */
  tryConsume(now: number = Date.now()): boolean {
    const elapsedSeconds = Math.max(0, (now - this.lastRefillMs) / 1000);
    if (elapsedSeconds > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + elapsedSeconds * this.refillPerSecond);
      this.lastRefillMs = now;
    }
    if (this.tokens < 1) {
      this.dropped += 1;
      return false;
    }
    this.tokens -= 1;
    return true;
  }
}

export interface AuthoredBySession {
  userId: string;
  displayName: string;
  email: string;
  role: MembershipRole;
}

export class RoomClient {
  readonly id = randomUUID();
  readonly ownedAwarenessClientIds = new Set<number>();
  readonly awarenessLimiter = new AwarenessRateLimiter();
  closing = false;
  removed = false;
  /** Epoch seconds at which this socket's access token expires. */
  readonly expiresAt: number;

  constructor(
    readonly documentId: string,
    readonly actor: AuthoredBySession,
    readonly socket: RoomSocket,
    expiresAt: number,
  ) {
    this.expiresAt = expiresAt;
  }

  get canWrite(): boolean {
    return canEdit(this.actor.role);
  }

  /** True when the token that authorized this socket has expired. */
  isExpired(nowSeconds: number = Date.now() / 1000): boolean {
    return nowSeconds >= this.expiresAt;
  }
}

/**
 * One live Y.Doc per document on this node. Persistent client updates are
 * serialized through writeTail so a single room applies them in acceptance
 * order; Postgres, not the room, is the cross-node serialization point.
 */
export class RealtimeRoom {
  private readonly doc = new Y.Doc();
  private readonly awareness: Awareness;
  private readonly logger: Logger;
  private readonly syncChannel: string;
  private readonly awarenessChannel: string;
  private readonly clients = new Set<RoomClient>();
  private readonly awarenessOwners = new Map<number, RoomClient>();
  private readonly subscriptions: PubSubSubscription[] = [];
  private readonly queuedEnvelopes: RedisEnvelope[] = [];
  private writeTail: Promise<void> = Promise.resolve();
  private pendingWrites = 0;
  private updatesSinceSnapshot = 0;
  private compactionPromise: Promise<void> | null = null;
  private snapshotTimer: NodeJS.Timeout | null = null;
  private sessionSweepTimer: NodeJS.Timeout | null = null;
  private ready = false;
  private closing = false;
  private closePromise: Promise<void> | null = null;

  constructor(
    readonly documentId: string,
    private readonly store: RealtimeDocumentStore,
    private readonly pubsub: PubSub,
    private readonly options: RealtimeRuntimeOptions,
  ) {
    this.logger = options.logger.child({ component: "room", documentId });
    this.syncChannel = documentSyncChannel(options.channelPrefix, documentId);
    this.awarenessChannel = documentAwarenessChannel(options.channelPrefix, documentId);
    this.awareness = new Awareness(this.doc);
    // The server is not a participant. Clearing the constructor's default
    // local state prevents a phantom user appearing in every client's presence.
    this.awareness.setLocalState(null);
  }

  get clientCount(): number {
    return this.clients.size;
  }

  async initialize(): Promise<void> {
    try {
      const syncSubscription = await this.pubsub.subscribe(
        this.syncChannel,
        (channel, payload) => {
          this.onPubSubMessage(channel, payload);
        },
      );
      if (this.closing) {
        await syncSubscription.unsubscribe();
        throw new Error("Room closed during initialization");
      }
      this.subscriptions.push(syncSubscription);

      const awarenessSubscription = await this.pubsub.subscribe(
        this.awarenessChannel,
        (channel, payload) => {
          this.onPubSubMessage(channel, payload);
        },
      );
      if (this.closing) {
        await awarenessSubscription.unsubscribe();
        throw new Error("Room closed during initialization");
      }
      this.subscriptions.push(awarenessSubscription);

      const state = await this.store.loadForColdStart(this.documentId);
      if (this.closing) throw new Error("Room closed during initialization");

      if (state.snapshot) {
        Y.applyUpdate(this.doc, state.snapshot, "postgres-snapshot");
      }
      for (const stored of state.updates) {
        Y.applyUpdate(this.doc, stored.update, "postgres-update");
      }

      this.ready = true;
      this.startSnapshotTimer();
      this.startSessionSweep();

      const queued = this.queuedEnvelopes.splice(0);
      for (const envelope of queued) {
        this.applyEnvelope(envelope);
      }

      void this.requestAwarenessSnapshot().catch((error: unknown) => {
        this.logger.warn({ err: error }, "failed to request cross-node awareness snapshot");
      });

      this.logger.info(
        {
          snapshotUpdates: state.updates.length,
          latestUpdateId: state.latestUpdateId,
          queuedEnvelopes: queued.length,
        },
        "room hydrated",
      );
    } catch (error) {
      await this.unsubscribeAll();
      throw error;
    }
  }

  addClient(actor: AuthenticatedActor, socket: RoomSocket): RoomClient {
    if (this.closing) throw new Error("Room is closing");
    if (!this.ready) throw new Error("Room is not ready");
    if (!socket.isOpen()) throw new Error("WebSocket closed before room join");

    const client = new RoomClient(
      this.documentId,
      {
        userId: actor.userId,
        displayName: actor.displayName,
        email: actor.email,
        role: actor.role,
      },
      socket,
      actor.expiresAt,
    );

    this.clients.add(client);
    try {
      this.send(client, encodeSyncStep1(this.doc));
      const awarenessSnapshot = encodeAwarenessSnapshot(this.awareness);
      if (awarenessSnapshot) this.send(client, awarenessSnapshot);
    } catch (error) {
      this.clients.delete(client);
      throw error;
    }

    this.logger.debug({ clientId: client.id, userId: actor.userId }, "client joined room");
    return client;
  }

  async handleMessage(client: RoomClient, data: Uint8Array, isBinary: boolean): Promise<void> {
    if (this.closing || client.closing || !this.clients.has(client)) return;
    if (!isBinary) {
      this.closeClient(client, CLOSE_CODE.INVALID_FRAME, "Binary frames only");
      return;
    }

    let frame: ReturnType<typeof parseClientFrame>;
    try {
      frame = parseClientFrame(data, this.options.maxUpdateBytes);
    } catch (error) {
      this.handleProtocolError(client, error);
      return;
    }

    switch (frame.type) {
      case "sync-step-1":
        try {
          this.send(client, encodeSyncStep2(this.doc, frame.stateVector));
        } catch (error) {
          this.logger.warn({ err: error, clientId: client.id }, "failed to send sync step 2");
        }
        return;

      case "sync-update": {
        if (!client.canWrite) {
          if (frame.subtype === "update") {
            this.closeClient(
              client,
              CLOSE_CODE.READ_ONLY,
              "Viewers cannot send document updates",
            );
          }
          return;
        }

        let hasContent: boolean;
        try {
          hasContent = validateUpdateForPersistence(frame.update);
        } catch (error) {
          this.handleProtocolError(client, error);
          return;
        }
        if (!hasContent) return;

        await this.enqueueUpdate(client, frame.update);
        return;
      }

      case "awareness":
        await this.applyLocalAwareness(client, frame.update, frame.clientIds);
        return;

      case "query-awareness": {
        const snapshot = encodeAwarenessSnapshot(this.awareness);
        if (snapshot) {
          try {
            this.send(client, snapshot);
          } catch (error) {
            this.logger.warn(
              { err: error, clientId: client.id },
              "failed to send awareness snapshot",
            );
          }
        }
        return;
      }
    }
  }

  async removeClient(client: RoomClient): Promise<void> {
    if (client.removed) return;
    client.removed = true;
    client.closing = true;
    this.clients.delete(client);

    const ownedIds = Array.from(client.ownedAwarenessClientIds);
    const removal = removeAwarenessAndEncode(this.awareness, ownedIds);
    for (const clientId of ownedIds) {
      if (this.awarenessOwners.get(clientId) === client) {
        this.awarenessOwners.delete(clientId);
      }
    }
    client.ownedAwarenessClientIds.clear();

    if (removal) {
      this.broadcast(encodeAwarenessFrame(removal));
      await this.publishAwareness(removal);
    }

    this.logger.debug({ clientId: client.id, userId: client.actor.userId }, "client left room");
  }

  async close(reason: string): Promise<void> {
    if (this.closePromise) return this.closePromise;

    this.closing = true;
    this.closePromise = (async () => {
      if (this.snapshotTimer) {
        clearInterval(this.snapshotTimer);
        this.snapshotTimer = null;
      }
      if (this.sessionSweepTimer) {
        clearInterval(this.sessionSweepTimer);
        this.sessionSweepTimer = null;
      }

      await this.unsubscribeAll();
      await this.writeTail;

      if (this.ready) {
        try {
          // Wait for any threshold/interval compaction that began before the
          // last writes drained, then take one final snapshot so every durable
          // update made by this room is covered before it is evicted.
          if (this.compactionPromise) await this.compactionPromise;
          await this.compactNow("room_close");
        } catch (error) {
          this.logger.error({ err: error }, "final room compaction failed");
        }
      }

      for (const client of this.clients) {
        if (client.socket.isOpen()) {
          try {
            client.socket.close(CLOSE_CODE.SERVER_RESTART, "Room closed");
          } catch {
            // The socket is already gone.
          }
        }
      }
      this.clients.clear();
      this.awarenessOwners.clear();
      this.queuedEnvelopes.length = 0;

      this.doc.destroy();
      this.ready = false;
      this.logger.info({ reason }, "room closed");
    })();

    return this.closePromise;
  }

  private async enqueueUpdate(client: RoomClient, update: Uint8Array): Promise<void> {
    if (this.pendingWrites >= MAX_PENDING_WRITES) {
      this.closeClient(
        client,
        CLOSE_CODE.TRY_AGAIN_LATER,
        "Too many pending document updates",
      );
      return;
    }

    this.pendingWrites += 1;
    const task = this.writeTail.then(async () => {
      await this.persistAndApply(client, update);
    });
    this.writeTail = task.catch(() => undefined).finally(() => {
      this.pendingWrites -= 1;
    });
    await task;
  }

  private async persistAndApply(client: RoomClient, update: Uint8Array): Promise<void> {
    let updateId: string;
    try {
      const result = await this.store.appendUpdate({
        documentId: this.documentId,
        actorId: client.actor.userId,
        update,
      });
      updateId = result.updateId;
    } catch (error) {
      this.logger.error(
        { err: error, clientId: client.id, documentId: this.documentId },
        "failed to persist Yjs update",
      );
      if (isCode(error, "forbidden")) {
        this.closeClient(
          client,
          CLOSE_CODE.FORBIDDEN,
          "Your write permission was revoked; reconnect and reload",
        );
      } else {
        this.closeClient(
          client,
          CLOSE_CODE.INTERNAL_ERROR,
          "Could not persist the update; reconnect and retry",
        );
      }
      return;
    }

    try {
      Y.applyUpdate(this.doc, update, PERSISTED_ORIGIN);
    } catch (error) {
      // The update was validated before persistence, so reaching this branch
      // indicates a programming or storage corruption issue, not client input.
      this.logger.fatal(
        { err: error, updateId, documentId: this.documentId },
        "persisted update failed to apply",
      );
      this.closeClient(client, CLOSE_CODE.INTERNAL_ERROR, "Server could not apply the update");
      return;
    }

    this.broadcast(encodeUpdateFrame(update));
    this.noteAppliedUpdate();

    const envelope: RedisUpdateEnvelope = {
      version: 1,
      kind: "update",
      documentId: this.documentId,
      originNodeId: this.options.nodeId,
      publishedAt: Date.now(),
      updateId,
      actorId: client.actor.userId,
      update: Buffer.from(update).toString("base64"),
    };

    try {
      await this.pubsub.publish(this.syncChannel, JSON.stringify(envelope));
    } catch (error) {
      // The write is durable. Other nodes will catch up on reconnect or cold
      // start; the design intentionally does not add an outbox here.
      this.logger.error(
        { err: error, documentId: this.documentId, updateId },
        "durable update failed to fan out through Redis",
      );
    }
  }

  private async applyLocalAwareness(
    client: RoomClient,
    update: Uint8Array,
    clientIds: number[],
  ): Promise<void> {
    // Flood control runs before any parsing or fan-out so a hostile client
    // cannot spend Redis capacity or CPU. Dropped frames are counted, not fatal.
    if (!client.awarenessLimiter.tryConsume()) {
      const dropped = client.awarenessLimiter.droppedCount;
      // Log at most once per 5s per socket: a flood would otherwise produce a
      // log line per dropped frame and turn a rate-limit into a disk problem.
      if (dropped === 1 || dropped % 300 === 0) {
        this.logger.warn(
          { clientId: client.id, userId: client.actor.userId, dropped },
          "dropped awareness frames over rate limit",
        );
      }
      return;
    }

    try {
      awarenessProtocol.applyAwarenessUpdate(this.awareness, update, client.id);
    } catch (error) {
      this.logger.debug({ err: error, clientId: client.id }, "invalid awareness update");
      this.closeClient(client, CLOSE_CODE.INVALID_FRAME, "Invalid awareness update");
      return;
    }

    this.sanitizeChatState(clientIds);

    // y-websocket providers re-broadcast awareness states they just learned.
    // That means a socket can legitimately send a client id introduced by
    // another socket. Ownership is only a first-seen heuristic used to clean
    // up presence after an abrupt disconnect; never reject a relay.
    for (const clientId of clientIds) {
      if (!this.awarenessOwners.has(clientId)) {
        this.awarenessOwners.set(clientId, client);
        client.ownedAwarenessClientIds.add(clientId);
      }
    }

    this.broadcast(encodeAwarenessFrame(update));
    void this.publishAwareness(update).catch((error: unknown) => {
      this.logger.error({ err: error }, "failed to fan out awareness update");
    });
  }

  /**
   * Clamp cursor-chat fields on the states this frame touched.
   *
   * Chat is ephemeral and never persisted, so the only risk is size: an
   * oversized chatText would be relayed to every peer and every node. It is
   * truncated rather than rejected, because dropping the whole awareness frame
   * would also drop the sender's cursor and selection.
   */
  private sanitizeChatState(clientIds: number[]): void {
    for (const clientId of clientIds) {
      const state = this.awareness.getStates().get(clientId);
      if (!state) continue;
      const rawChat = state["chatText"];
      if (typeof rawChat === "string" && rawChat.length > MAX_CHAT_TEXT_LENGTH) {
        this.awareness.states.set(clientId, {
          ...state,
          chatText: rawChat.slice(0, MAX_CHAT_TEXT_LENGTH),
        });
      }
    }
  }

  /**
   * Close sockets whose access token has expired.
   *
   * The token is checked at upgrade time only, so without this sweep a socket
   * opened with a one-hour token would stay writable indefinitely. 4408 is
   * inside the 4400 range that y-websocket treats as non-retryable, so the
   * client stops reconnecting and sends the user back to sign-in instead of
   * looping against a token that will never become valid again.
   */
  private startSessionSweep(): void {
    if (this.sessionSweepTimer) return;
    this.sessionSweepTimer = setInterval(() => {
      this.sweepExpiredSessions();
    }, SESSION_SWEEP_INTERVAL_MS);
    this.sessionSweepTimer.unref?.();
  }

  /** Exposed for tests: run one expiry pass immediately. */
  sweepExpiredSessions(nowSeconds: number = Date.now() / 1000): number {
    if (this.closing) return 0;
    let closed = 0;
    for (const client of [...this.clients]) {
      if (!client.isExpired(nowSeconds)) continue;
      this.logger.info(
        { clientId: client.id, userId: client.actor.userId },
        "closing socket with expired session",
      );
      this.closeClient(client, CLOSE_CODE.SESSION_EXPIRED, "Session expired");
      closed += 1;
    }
    return closed;
  }

  private onPubSubMessage(channel: string, payload: string): void {
    if (this.closing) return;

    let parsed: ReturnType<typeof redisEnvelopeSchema.safeParse>;
    try {
      parsed = redisEnvelopeSchema.safeParse(JSON.parse(payload));
    } catch {
      this.logger.warn({ channel }, "discarded non-JSON Redis message");
      return;
    }
    if (!parsed.success) {
      this.logger.warn({ channel, issues: parsed.error.issues.length }, "discarded invalid Redis envelope");
      return;
    }

    const envelope = parsed.data;
    if (envelope.documentId !== this.documentId) {
      this.logger.warn(
        { channel, envelopeDocumentId: envelope.documentId },
        "discarded Redis message for a different document",
      );
      return;
    }
    if (envelope.kind === "update" && channel !== this.syncChannel) {
      this.logger.warn({ channel }, "discarded update on the wrong Redis channel");
      return;
    }
    if (envelope.kind !== "update" && channel !== this.awarenessChannel) {
      this.logger.warn({ channel, kind: envelope.kind }, "discarded presence on the wrong Redis channel");
      return;
    }

    // Redis does not deliver a message back to the connection that published
    // it. This guard is defense in depth for duplicated subscribers, tests,
    // and future transports that may echo messages.
    if (envelope.originNodeId === this.options.nodeId) return;

    if (envelope.kind === "awareness-sync-request") {
      void this.replyWithLocallyOwnedAwareness().catch((error: unknown) => {
        this.logger.warn({ err: error }, "failed to answer awareness sync request");
      });
      return;
    }

    if (!this.ready) {
      if (this.queuedEnvelopes.length >= MAX_QUEUED_ENVELOPES) {
        this.logger.error(
          { channel, queueLength: this.queuedEnvelopes.length },
          "dropping Redis envelope while room backlog is full",
        );
        return;
      }
      this.queuedEnvelopes.push(envelope);
      return;
    }

    this.applyEnvelope(envelope);
  }

  private applyEnvelope(envelope: RedisEnvelope): void {
    if (envelope.kind === "update") {
      this.applyRemoteUpdate(envelope);
    } else if (envelope.kind === "awareness") {
      this.applyRemoteAwareness(envelope);
    }
  }

  private applyRemoteUpdate(envelope: RedisUpdateEnvelope): void {
    let update: Uint8Array;
    try {
      update = Buffer.from(envelope.update, "base64");
    } catch {
      this.logger.warn({ updateId: envelope.updateId }, "discarded malformed base64 update");
      return;
    }
    if (update.byteLength > this.options.maxUpdateBytes) {
      this.logger.warn(
        { updateId: envelope.updateId, bytes: update.byteLength },
        "discarded oversized remote update",
      );
      return;
    }

    try {
      Y.applyUpdate(this.doc, update, REDIS_ORIGIN);
    } catch (error) {
      this.logger.error(
        { err: error, updateId: envelope.updateId },
        "remote Yjs update failed to apply",
      );
      return;
    }

    this.broadcast(encodeUpdateFrame(update));
    this.noteAppliedUpdate(envelope.originNodeId);
  }

  private applyRemoteAwareness(envelope: RedisAwarenessEnvelope): void {
    let update: Uint8Array;
    try {
      update = Buffer.from(envelope.awareness, "base64");
    } catch {
      this.logger.warn({ originNodeId: envelope.originNodeId }, "discarded malformed awareness");
      return;
    }

    try {
      awarenessProtocol.applyAwarenessUpdate(this.awareness, update, REDIS_ORIGIN);
    } catch (error) {
      this.logger.warn({ err: error }, "remote awareness update failed to apply");
      return;
    }
    this.broadcast(encodeAwarenessFrame(update));
  }

  private noteAppliedUpdate(originNodeId?: string): void {
    this.updatesSinceSnapshot += 1;
    if (
      !this.closing &&
      this.updatesSinceSnapshot >= this.options.snapshotEveryUpdates
    ) {
      void this.compactNow(originNodeId ? "remote_threshold" : "threshold");
    }
  }

  private compactNow(reason: string): Promise<void> {
    if (this.compactionPromise) return this.compactionPromise;

    const before = this.updatesSinceSnapshot;
    const promise = this.store
      .compact(this.documentId, { retention: this.options.snapshotRetention })
      .then((result) => {
        // A null result means another node compacted past every update this
        // room had applied, so the local dirty counter is still resolved.
        this.updatesSinceSnapshot = Math.max(0, this.updatesSinceSnapshot - before);
        if (result) {
          this.logger.info(
            {
              reason,
              snapshotVersion: result.version,
              throughUpdateId: result.throughUpdateId,
              updatesRemoved: result.updatesRemoved,
            },
            "document snapshot written",
          );
        }
      })
      .catch((error: unknown) => {
        this.logger.error({ err: error, reason }, "document snapshot failed");
      })
      .finally(() => {
        this.compactionPromise = null;
      });

    this.compactionPromise = promise;
    return promise;
  }

  private startSnapshotTimer(): void {
    this.snapshotTimer = setInterval(() => {
      if (!this.closing && this.updatesSinceSnapshot > 0) {
        void this.compactNow("interval");
      }
    }, this.options.snapshotIntervalMs);
    this.snapshotTimer.unref();
  }

  private async publishAwareness(update: Uint8Array): Promise<void> {
    if (this.closing) return;
    const envelope: RedisAwarenessEnvelope = {
      version: 1,
      kind: "awareness",
      documentId: this.documentId,
      originNodeId: this.options.nodeId,
      publishedAt: Date.now(),
      awareness: Buffer.from(update).toString("base64"),
    };
    await this.pubsub.publish(this.awarenessChannel, JSON.stringify(envelope));
  }

  private async requestAwarenessSnapshot(): Promise<void> {
    if (this.closing) return;
    await this.pubsub.publish(
      this.awarenessChannel,
      JSON.stringify({
        version: 1,
        kind: "awareness-sync-request",
        documentId: this.documentId,
        originNodeId: this.options.nodeId,
        publishedAt: Date.now(),
      }),
    );
  }

  private async replyWithLocallyOwnedAwareness(): Promise<void> {
    if (this.closing) return;
    const localClientIds = Array.from(this.awarenessOwners.keys()).filter((clientId) =>
      this.awareness.getStates().has(clientId),
    );
    if (localClientIds.length === 0) return;
    const update = awarenessProtocol.encodeAwarenessUpdate(this.awareness, localClientIds);
    await this.publishAwareness(update);
  }

  private broadcast(frame: Uint8Array): void {
    for (const client of this.clients) {
      if (client.closing || !client.socket.isOpen()) continue;
      try {
        client.socket.send(frame);
      } catch (error) {
        this.logger.warn({ err: error, clientId: client.id }, "WebSocket send failed");
        this.closeClient(client, CLOSE_CODE.INTERNAL_ERROR, "WebSocket send failed");
      }
    }
  }

  private send(client: RoomClient, frame: Uint8Array): void {
    if (!client.socket.isOpen()) throw new Error("WebSocket is not open");
    client.socket.send(frame);
  }

  private closeClient(client: RoomClient, code: number, reason: string): void {
    if (client.closing) return;
    client.closing = true;
    try {
      client.socket.close(code, truncateCloseReason(reason));
    } catch (error) {
      this.logger.warn({ err: error, clientId: client.id }, "WebSocket close failed");
    }
  }

  private handleProtocolError(client: RoomClient, error: unknown): void {
    if (error instanceof ProtocolViolation) {
      this.closeClient(client, error.closeCode, error.message);
      return;
    }
    this.logger.warn({ err: error, clientId: client.id }, "unexpected protocol handler failure");
    this.closeClient(client, CLOSE_CODE.INVALID_FRAME, "Protocol error");
  }

  private async unsubscribeAll(): Promise<void> {
    const results = await Promise.allSettled(
      this.subscriptions.splice(0).map((subscription) => subscription.unsubscribe()),
    );
    for (const result of results) {
      if (result.status === "rejected") {
        this.logger.warn({ err: result.reason }, "failed to unsubscribe Redis channel");
      }
    }
  }
}

function isCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}
