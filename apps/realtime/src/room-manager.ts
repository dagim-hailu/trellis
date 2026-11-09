import type { Logger } from "pino";

import { RealtimeRoom, type RoomClient } from "./room.js";
import type {
  AuthenticatedActor,
  RealtimeDocumentStore,
  RealtimeRuntimeOptions,
  RoomSocket,
} from "./types.js";

export class RoomManagerShuttingDownError extends Error {
  constructor() {
    super("Realtime node is shutting down");
    this.name = "RoomManagerShuttingDownError";
  }
}

interface RoomEntry {
  documentId: string;
  room: RealtimeRoom;
  state: "loading" | "ready" | "closing";
  references: number;
  failure: Error | null;
  ready: Promise<void>;
  closed: Promise<void>;
  resolveClosed: () => void;
  closePromise: Promise<void> | null;
}

export interface RoomManagerOptions extends RealtimeRuntimeOptions {
  logger: Logger;
}

/**
 * Reference-counted map of document rooms on this node.
 *
 * A room is loaded once, serving every local socket for that document. The
 * last socket departure closes the room: both Redis channels are unsubscribed,
 * writes drain, a final snapshot is attempted, and the Y.Doc is destroyed.
 * A reconnect that arrives while closure is in progress waits for the old room
 * to finish before a new room is created, avoiding a load/commit race.
 */
export class RoomManager {
  private readonly rooms = new Map<string, RoomEntry>();
  private readonly clientEntries = new WeakMap<RoomClient, RoomEntry>();
  private shuttingDown = false;
  private readonly logger: Logger;

  constructor(
    private readonly store: RealtimeDocumentStore,
    private readonly options: RoomManagerOptions,
  ) {
    this.logger = options.logger.child({ component: "room-manager" });
  }

  get roomCount(): number {
    return this.rooms.size;
  }

  hasRoom(documentId: string): boolean {
    return this.rooms.has(documentId);
  }

  async connect(input: {
    documentId: string;
    actor: AuthenticatedActor;
    socket: RoomSocket;
  }): Promise<RoomClient> {
    if (this.shuttingDown) throw new RoomManagerShuttingDownError();

    for (;;) {
      let entry = this.rooms.get(input.documentId);
      let created = false;

      if (!entry) {
        if (this.shuttingDown) throw new RoomManagerShuttingDownError();
        entry = this.createEntry(input.documentId);
        this.rooms.set(input.documentId, entry);
        created = true;
      }

      if (!created) {
        if (entry.state === "closing") {
          await entry.closed;
          continue;
        }
        entry.references += 1;
      }

      try {
        await entry.ready;
        if (this.shuttingDown) throw new RoomManagerShuttingDownError();
        if (entry.state !== "ready") {
          throw entry.failure ?? new Error("Room failed to initialize");
        }

        const client = entry.room.addClient(input.actor, input.socket);
        this.clientEntries.set(client, entry);
        return client;
      } catch (error) {
        entry.references = Math.max(0, entry.references - 1);
        if (entry.references === 0 && entry.state !== "closing") {
          void this.beginClose(entry, "connect_failed");
        }
        if (error instanceof RoomManagerShuttingDownError) throw error;
        this.logger.warn(
          { err: error, documentId: input.documentId },
          "failed to join document room",
        );
        throw error;
      }
    }
  }

  async handleMessage(
    client: RoomClient,
    data: Uint8Array,
    isBinary: boolean,
  ): Promise<void> {
    const entry = this.clientEntries.get(client);
    if (!entry) return;
    await entry.room.handleMessage(client, data, isBinary);
  }

  async disconnect(client: RoomClient): Promise<void> {
    const entry = this.clientEntries.get(client);
    if (!entry) return;
    this.clientEntries.delete(client);

    try {
      await entry.room.removeClient(client);
    } catch (error) {
      this.logger.error(
        { err: error, documentId: client.documentId, clientId: client.id },
        "failed to clean up room client",
      );
    } finally {
      entry.references = Math.max(0, entry.references - 1);
      if (entry.references === 0 && entry.state !== "closing") {
        await this.beginClose(entry, "last_client_left");
      }
    }
  }

  async shutdown(): Promise<void> {
    if (this.shuttingDown) {
      await Promise.allSettled(
        Array.from(this.rooms.values()).map((entry) => entry.closePromise ?? entry.closed),
      );
      return;
    }
    this.shuttingDown = true;

    const entries = Array.from(this.rooms.values());
    await Promise.allSettled(
      entries.map((entry) => {
        entry.references = 0;
        return this.beginClose(entry, "server_shutdown");
      }),
    );
  }

  private createEntry(documentId: string): RoomEntry {
    const room = new RealtimeRoom(documentId, this.store, this.options.pubsub, this.options);
    let resolveClosed!: () => void;
    const closed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });

    const entry: RoomEntry = {
      documentId,
      room,
      state: "loading",
      references: 1,
      failure: null,
      ready: Promise.resolve(),
      closed,
      resolveClosed,
      closePromise: null,
    };

    entry.ready = room.initialize().then(
      () => {
        if (entry.state === "loading") entry.state = "ready";
      },
      (error: unknown) => {
        entry.failure = error instanceof Error ? error : new Error(String(error));
        if (entry.state === "loading") entry.state = "closing";
        throw error;
      },
    );

    return entry;
  }

  private beginClose(entry: RoomEntry, reason: string): Promise<void> {
    if (entry.closePromise) return entry.closePromise;

    entry.state = "closing";
    this.logger.info({ documentId: entry.documentId, reason }, "closing document room");

    const closePromise = entry.room
      .close(reason)
      .catch((error: unknown) => {
        this.logger.error(
          { err: error, documentId: entry.documentId, reason },
          "room close failed",
        );
      })
      .finally(() => {
        if (this.rooms.get(entry.documentId) === entry) {
          this.rooms.delete(entry.documentId);
        }
        entry.resolveClosed();
      });

    entry.closePromise = closePromise;
    return closePromise;
  }
}
