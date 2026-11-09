import { afterEach, describe, expect, it } from "vitest";

import { CLOSE_CODE } from "@trellis/shared";

import { RealtimeRoom } from "../room.js";
import { FakeBus, FakeDocumentStore, FakePubSub, FakeSocket, actorFor, runtimeOptions } from "./helpers.js";

const DOCUMENT_ID = "3f0a2b1c-4d5e-4f60-8a7b-9c1d2e3f4a5b";
const USER_ID = "60b403ec-c56c-41fe-84ce-bca14b33e3bb";

const openRooms: RealtimeRoom[] = [];

afterEach(async () => {
  for (const room of openRooms.splice(0)) {
    await room.close("test cleanup").catch(() => undefined);
  }
});

async function makeRoom(): Promise<{ room: RealtimeRoom; store: FakeDocumentStore }> {
  const store = new FakeDocumentStore();
  store.grantAccess(DOCUMENT_ID, USER_ID, "editor");
  const pubsub = new FakePubSub(new FakeBus(), "node-expiry");
  const room = new RealtimeRoom(DOCUMENT_ID, store, pubsub, runtimeOptions(store, pubsub));
  await room.initialize();
  openRooms.push(room);
  return { room, store };
}

describe("session expiry sweep", () => {
  it("closes a socket whose token has expired with 4408", async () => {
    const { room } = await makeRoom();
    const socket = new FakeSocket();
    const nowSeconds = Math.floor(Date.now() / 1000);

    // Token already expired on arrival.
    room.addClient(actorFor(USER_ID, "editor", "Ada", nowSeconds - 10), socket);
    expect(socket.open).toBe(true);

    const closed = room.sweepExpiredSessions(nowSeconds);

    expect(closed).toBe(1);
    expect(socket.closeCode).toContain(CLOSE_CODE.SESSION_EXPIRED);
    expect(socket.open).toBe(false);
  });

  it("leaves a live session connected", async () => {
    const { room } = await makeRoom();
    const socket = new FakeSocket();
    const nowSeconds = Math.floor(Date.now() / 1000);

    room.addClient(actorFor(USER_ID, "editor", "Ada", nowSeconds + 3_600), socket);
    const closed = room.sweepExpiredSessions(nowSeconds);

    expect(closed).toBe(0);
    expect(socket.closeCode).toHaveLength(0);
    expect(socket.open).toBe(true);
  });

  it("closes only the expired sockets in a mixed room", async () => {
    const { room } = await makeRoom();
    const nowSeconds = Math.floor(Date.now() / 1000);
    const stale = new FakeSocket();
    const fresh = new FakeSocket();

    room.addClient(actorFor(USER_ID, "editor", "Ada", nowSeconds - 1), stale);
    room.addClient(
      actorFor("b4f5d54f-55cf-4e22-8cd1-bfc5f18f0e65", "viewer", "Grace", nowSeconds + 600),
      fresh,
    );

    const closed = room.sweepExpiredSessions(nowSeconds);

    expect(closed).toBe(1);
    expect(stale.closeCode).toContain(CLOSE_CODE.SESSION_EXPIRED);
    expect(fresh.closeCode).toHaveLength(0);
  });

  it("treats the expiry instant as expired", async () => {
    const { room } = await makeRoom();
    const socket = new FakeSocket();
    const nowSeconds = Math.floor(Date.now() / 1000);

    room.addClient(actorFor(USER_ID, "editor", "Ada", nowSeconds), socket);
    expect(room.sweepExpiredSessions(nowSeconds)).toBe(1);
  });

  it("does nothing once the room is closing", async () => {
    const { room } = await makeRoom();
    const socket = new FakeSocket();
    const nowSeconds = Math.floor(Date.now() / 1000);
    room.addClient(actorFor(USER_ID, "editor", "Ada", nowSeconds - 10), socket);

    await room.close("shutting down");
    // The room is closed; a later sweep must not throw or double-close.
    expect(room.sweepExpiredSessions(nowSeconds)).toBe(0);
  });
});
