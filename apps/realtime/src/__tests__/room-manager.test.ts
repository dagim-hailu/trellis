import { describe, expect, it } from "vitest";
import * as decoding from "lib0/decoding";
import * as Y from "yjs";
import * as awarenessProtocol from "y-protocols/awareness";
import { Awareness } from "y-protocols/awareness";

import { WS_MESSAGE, documentSyncChannel, type RedisUpdateEnvelope } from "@trellis/shared";

import { encodeAwarenessFrame, encodeSyncStep1, encodeUpdateFrame } from "../protocol.js";
import { RoomManager } from "../room-manager.js";
import {
  DOCUMENT_ID,
  FakeBus,
  FakeDocumentStore,
  FakePubSub,
  FakeSocket,
  USER_ID,
  actorFor,
  runtimeOptions,
} from "./helpers.js";

interface ParsedServerFrame {
  messageType: number;
  subtype?: number;
  payload?: Uint8Array;
}

function parseServerFrame(frame: Uint8Array): ParsedServerFrame {
  const decoder = decoding.createDecoder(frame);
  const messageType = decoding.readVarUint(decoder);
  if (messageType === WS_MESSAGE.SYNC) {
    const subtype = decoding.readVarUint(decoder);
    if (subtype === 0) {
      const stateVector = decoding.readVarUint8Array(decoder);
      return { messageType, subtype, payload: stateVector };
    }
    const update = decoding.readVarUint8Array(decoder);
    return { messageType, subtype, payload: update };
  }
  if (messageType === WS_MESSAGE.AWARENESS) {
    return { messageType, payload: decoding.readVarUint8Array(decoder) };
  }
  return { messageType };
}

function updateFrames(socket: FakeSocket): Uint8Array[] {
  return socket.frames
    .map(parseServerFrame)
    .filter((frame) => frame.messageType === WS_MESSAGE.SYNC && frame.subtype === 2)
    .map((frame) => frame.payload)
    .filter((payload): payload is Uint8Array => payload !== undefined);
}

describe("RoomManager room lifecycle", () => {
  it("loads once, subscribes to both channels, and tears down after the last client", async () => {
    const store = new FakeDocumentStore();
    const pubsub = new FakePubSub(new FakeBus(), "node-lifecycle");
    const manager = new RoomManager(
      store,
      runtimeOptions(store, pubsub, { nodeId: "node-lifecycle" }),
    );

    const socket = new FakeSocket();
    const client = await manager.connect({
      documentId: DOCUMENT_ID,
      actor: actorFor(USER_ID, "editor"),
      socket,
    });

    expect(manager.roomCount).toBe(1);
    expect(store.loadCalls).toEqual([DOCUMENT_ID]);
    expect(pubsub.channelCount).toBe(2);
    expect(pubsub.subscriptions.has(documentSyncChannel("test", DOCUMENT_ID))).toBe(true);
    expect(socket.frames.length).toBeGreaterThanOrEqual(1);

    await manager.disconnect(client);

    expect(manager.roomCount).toBe(0);
    expect(pubsub.channelCount).toBe(0);
    expect(store.compactionCalls).toContain(DOCUMENT_ID);
    await pubsub.close();
  });

  it("reuses one room for every socket until the last disconnect", async () => {
    const store = new FakeDocumentStore();
    const pubsub = new FakePubSub(new FakeBus(), "node-reuse");
    const manager = new RoomManager(
      store,
      runtimeOptions(store, pubsub, { nodeId: "node-reuse" }),
    );

    const first = await manager.connect({
      documentId: DOCUMENT_ID,
      actor: actorFor(USER_ID, "editor"),
      socket: new FakeSocket(),
    });
    const second = await manager.connect({
      documentId: DOCUMENT_ID,
      actor: actorFor(USER_ID, "viewer"),
      socket: new FakeSocket(),
    });

    expect(store.loadCalls).toEqual([DOCUMENT_ID]);
    expect(pubsub.channelCount).toBe(2);

    await manager.disconnect(first);
    expect(manager.roomCount).toBe(1);
    expect(pubsub.channelCount).toBe(2);

    await manager.disconnect(second);
    expect(manager.roomCount).toBe(0);
    expect(pubsub.channelCount).toBe(0);
    await pubsub.close();
  });
});

describe("persistent updates and echo avoidance", () => {
  it("persists once and fans out exactly once to clients on two nodes", async () => {
    const bus = new FakeBus();
    const pubsubA = new FakePubSub(bus, "node-a");
    const pubsubB = new FakePubSub(bus, "node-b");
    const storeA = new FakeDocumentStore();
    const storeB = new FakeDocumentStore();

    const managerA = new RoomManager(
      storeA,
      runtimeOptions(storeA, pubsubA, { nodeId: "node-a" }),
    );
    const managerB = new RoomManager(
      storeB,
      runtimeOptions(storeB, pubsubB, { nodeId: "node-b" }),
    );

    const socketA = new FakeSocket();
    const socketB = new FakeSocket();
    const clientA = await managerA.connect({
      documentId: DOCUMENT_ID,
      actor: actorFor(USER_ID, "editor", "Ada"),
      socket: socketA,
    });
    const clientB = await managerB.connect({
      documentId: DOCUMENT_ID,
      actor: actorFor(
        "18e6d676-b8e5-4a15-a380-c30d71912086",
        "viewer",
        "Grace",
      ),
      socket: socketB,
    });

    const localDoc = new Y.Doc();
    localDoc.getMap("canvas").set("shape-1", { type: "rect", x: 10, y: 20 });
    const update = Y.encodeStateAsUpdate(localDoc);
    localDoc.destroy();

    await managerA.handleMessage(clientA, encodeUpdateFrame(update), true);

    // The hostile fake bus sent node-a's own envelope back to node-a. The
    // origin guard must keep that from producing a second update frame.
    expect(storeA.appendCalls).toHaveLength(1);
    expect(storeB.appendCalls).toHaveLength(0);
    expect(updateFrames(socketA)).toHaveLength(1);
    expect(updateFrames(socketB)).toHaveLength(1);

    const applied = new Y.Doc();
    Y.applyUpdate(applied, updateFrames(socketB)[0] as Uint8Array);
    expect(applied.getMap("canvas").get("shape-1")).toEqual({
      type: "rect",
      x: 10,
      y: 20,
    });
    applied.destroy();

    const busUpdateEnvelopes = bus.published
      .map((entry) => {
        try {
          return JSON.parse(entry.payload) as Partial<RedisUpdateEnvelope>;
        } catch {
          return null;
        }
      })
      .filter((envelope) => envelope?.kind === "update");
    expect(busUpdateEnvelopes).toHaveLength(1);
    expect(busUpdateEnvelopes[0]?.originNodeId).toBe("node-a");

    await managerA.disconnect(clientA);
    await managerB.disconnect(clientB);
    await pubsubA.close();
    await pubsubB.close();
  });

  it("accepts re-broadcast awareness from another y-websocket provider", async () => {
    const store = new FakeDocumentStore();
    const pubsub = new FakePubSub(new FakeBus(), "node-awareness");
    const manager = new RoomManager(
      store,
      runtimeOptions(store, pubsub, { nodeId: "node-awareness" }),
    );
    const socketA = new FakeSocket();
    const socketB = new FakeSocket();
    const clientA = await manager.connect({
      documentId: DOCUMENT_ID,
      actor: actorFor(USER_ID, "editor", "Ada"),
      socket: socketA,
    });
    const clientB = await manager.connect({
      documentId: DOCUMENT_ID,
      actor: actorFor(
        "b4f5d54f-55cf-4e22-8cd1-bfc5f18f0e65",
        "editor",
        "Grace",
      ),
      socket: socketB,
    });

    const awarenessDoc = new Y.Doc();
    const awareness = new Awareness(awarenessDoc);
    awareness.setLocalState({
      user: { id: USER_ID, name: "Ada", color: "#22c55e" },
      cursor: { x: 10, y: 20 },
      selection: [],
    });
    const update = awarenessProtocol.encodeAwarenessUpdate(awareness, [
      awarenessDoc.clientID,
    ]);
    const frame = encodeAwarenessFrame(update);
    awareness.destroy();
    awarenessDoc.destroy();

    await manager.handleMessage(clientA, frame, true);
    // y-websocket providers re-broadcast remote awareness updates they apply.
    // This must not be mistaken for one client hijacking another's id.
    await manager.handleMessage(clientB, frame, true);

    expect(socketA.closeCode).toHaveLength(0);
    expect(socketB.closeCode).toHaveLength(0);
    expect(socketB.frames.some((candidate) => parseServerFrame(candidate).messageType === 1)).toBe(
      true,
    );

    await manager.disconnect(clientA);
    await manager.disconnect(clientB);
    await pubsub.close();
  });

  it("rejects a viewer update without writing to Postgres", async () => {
    const store = new FakeDocumentStore();
    const pubsub = new FakePubSub(new FakeBus(), "node-viewer");
    const manager = new RoomManager(
      store,
      runtimeOptions(store, pubsub, { nodeId: "node-viewer" }),
    );
    const socket = new FakeSocket();
    const viewer = await manager.connect({
      documentId: DOCUMENT_ID,
      actor: actorFor(USER_ID, "viewer"),
      socket,
    });

    const doc = new Y.Doc();
    doc.getMap("canvas").set("blocked", true);
    const update = Y.encodeStateAsUpdate(doc);
    doc.destroy();

    await manager.handleMessage(viewer, encodeUpdateFrame(update), true);

    expect(store.appendCalls).toHaveLength(0);
    expect(socket.closeCode).toContain(4403);
    await manager.disconnect(viewer);
    await pubsub.close();
  });
});

describe("sync", () => {
  it("answers a client state vector with a sync step 2 from the hydrated document", async () => {
    const store = new FakeDocumentStore();
    const seeded = new Y.Doc();
    seeded.getMap("canvas").set("persisted", "yes");
    store.seedUpdate(DOCUMENT_ID, Y.encodeStateAsUpdate(seeded));
    seeded.destroy();

    const pubsub = new FakePubSub(new FakeBus(), "node-sync");
    const manager = new RoomManager(
      store,
      runtimeOptions(store, pubsub, { nodeId: "node-sync" }),
    );
    const socket = new FakeSocket();
    const client = await manager.connect({
      documentId: DOCUMENT_ID,
      actor: actorFor(USER_ID, "editor"),
      socket,
    });

    await manager.handleMessage(client, encodeSyncStep1(new Y.Doc()), true);
    const step2 = socket.frames
      .map(parseServerFrame)
      .find(
        (frame) =>
          frame.messageType === WS_MESSAGE.SYNC && frame.subtype === 1 && frame.payload,
      );
    expect(step2?.payload).toBeTruthy();

    const hydrated = new Y.Doc();
    if (step2?.payload) Y.applyUpdate(hydrated, step2.payload);
    expect(hydrated.getMap("canvas").get("persisted")).toBe("yes");
    hydrated.destroy();

    await manager.disconnect(client);
    await pubsub.close();
  });
});
