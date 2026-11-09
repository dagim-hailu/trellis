import { afterEach, describe, expect, it } from "vitest";
import { once } from "node:events";
import { WebSocket } from "ws";

import { TokenService } from "@trellis/auth";

import { createRealtimeServer, type RealtimeServer } from "../server.js";
import {
  DOCUMENT_ID,
  FakeBus,
  FakeDocumentStore,
  FakePubSub,
  TEST_SECRET,
  USER_ID,
  logger,
} from "./helpers.js";

const WEB_ORIGIN = "http://localhost:3100";
const TEST_ISSUER = "trellis-test";
const TEST_AUDIENCE = "trellis-test-client";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    if (cleanup) await cleanup();
  }
});

async function startServer(overrides?: {
  store?: FakeDocumentStore;
}): Promise<{
  server: RealtimeServer;
  port: number;
  store: FakeDocumentStore;
  tokens: TokenService;
  pubsub: FakePubSub;
}> {
  const store = overrides?.store ?? new FakeDocumentStore();
  const pubsub = new FakePubSub(new FakeBus(), "auth-node");
  const tokens = new TokenService({
    secret: TEST_SECRET,
    issuer: TEST_ISSUER,
    audience: TEST_AUDIENCE,
    ttlSeconds: 3600,
  });

  const server = createRealtimeServer({
    nodeId: "auth-node",
    channelPrefix: "test",
    maxUpdateBytes: 1_048_576,
    snapshotEveryUpdates: 10_000,
    snapshotIntervalMs: 60_000,
    snapshotRetention: 5,
    store,
    pubsub,
    logger,
    tokens,
    webOrigin: WEB_ORIGIN,
    authTimeoutMs: 1_000,
    readiness: async () => undefined,
  });

  const address = await server.listen(0, "127.0.0.1");
  cleanups.push(async () => {
    await server.close();
    await pubsub.close();
  });

  return { server, port: address.port, store, tokens, pubsub };
}

async function issueToken(tokens: TokenService): Promise<string> {
  const result = await tokens.issue({
    userId: USER_ID,
    email: "ada@example.test",
    displayName: "Ada",
  });
  return result.token;
}

function documentUrl(port: number): string {
  return `ws://127.0.0.1:${port}/ws/documents/${DOCUMENT_ID}`;
}

async function expectUpgradeRejected(
  url: string,
  options: { headers?: Record<string, string>; protocols?: string[] },
): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const ws = new WebSocket(url, options.protocols ?? [], {
      headers: options.headers ?? {},
      handshakeTimeout: 2_000,
    });
    ws.once("unexpected-response", (_request, response) => {
      const status = response.statusCode ?? 0;
      response.resume();
      ws.terminate();
      resolve(status);
    });
    ws.once("open", () => {
      ws.terminate();
      reject(new Error("Expected the WebSocket upgrade to be rejected"));
    });
    ws.once("error", () => {
      // 'unexpected-response' carries the status; ws may also emit error.
    });
  });
}

describe("WebSocket authentication", () => {
  it("rejects an upgrade without a token", async () => {
    const { port } = await startServer();
    const status = await expectUpgradeRejected(documentUrl(port), {
      headers: { origin: WEB_ORIGIN },
    });
    expect(status).toBe(401);
  });

  it("rejects an invalid access token", async () => {
    const { port } = await startServer();
    const status = await expectUpgradeRejected(documentUrl(port), {
      headers: {
        origin: WEB_ORIGIN,
        authorization: "Bearer definitely-not-a-token",
      },
    });
    expect(status).toBe(401);
  });

  it("rejects a valid token without document membership", async () => {
    const { port, tokens } = await startServer();
    const token = await issueToken(tokens);
    const status = await expectUpgradeRejected(documentUrl(port), {
      headers: {
        origin: WEB_ORIGIN,
        authorization: `Bearer ${token}`,
      },
    });
    expect(status).toBe(403);
  });

  it("rejects a disallowed browser origin before opening a socket", async () => {
    const { port, tokens, store } = await startServer();
    store.grantAccess(DOCUMENT_ID, USER_ID, "editor");
    const token = await issueToken(tokens);
    const status = await expectUpgradeRejected(documentUrl(port), {
      headers: {
        origin: "https://attacker.example",
        authorization: `Bearer ${token}`,
      },
    });
    expect(status).toBe(403);
  });

  it("accepts a member using the bearer subprotocol and opens a Yjs session", async () => {
    const { port, tokens, store, pubsub } = await startServer();
    store.grantAccess(DOCUMENT_ID, USER_ID, "editor");
    const token = await issueToken(tokens);

    const ws = new WebSocket(documentUrl(port), ["trellis.v1", `bearer.${token}`], {
      headers: { origin: WEB_ORIGIN },
      handshakeTimeout: 2_000,
    });
    cleanups.push(async () => {
      ws.terminate();
    });

    // Register before 'open': the server may send its sync step 1 immediately
    // after the handshake completes.
    const firstMessage = once(ws, "message");
    await once(ws, "open");
    expect(ws.protocol).toBe("trellis.v1");
    const [message] = (await firstMessage) as [Buffer, boolean];
    expect(message.byteLength).toBeGreaterThan(0);
    expect(pubsub.channelCount).toBe(2);

    ws.close(1000, "test complete");
    await once(ws, "close");
  });
});
