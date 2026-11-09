import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { TokenError, type TokenService } from "@trellis/auth";
import { CLOSE_CODE, MAX_AWARENESS_BYTES, documentIdSchema } from "@trellis/shared";
import type { Logger } from "pino";
import { WebSocket, WebSocketServer } from "ws";

import { RoomManager, RoomManagerShuttingDownError } from "./room-manager.js";
import type { RoomClient } from "./room.js";
import { toUint8Array, truncateCloseReason } from "./protocol.js";
import type {
  PubSub,
  RealtimeDocumentStore,
  RealtimeRuntimeOptions,
  RoomSocket,
} from "./types.js";

const WEBSOCKET_PROTOCOL = "trellis.v1";
const BEARER_PROTOCOL_PREFIX = "bearer.";
const UUID_PATH =
  /^\/ws\/documents\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;

export interface RealtimeServerOptions extends RealtimeRuntimeOptions {
  tokens: TokenService;
  webOrigin: string;
  authTimeoutMs: number;
  readiness: () => Promise<void>;
}

export interface RealtimeServer {
  readonly httpServer: ReturnType<typeof createServer>;
  readonly roomManager: RoomManager;
  listen(port: number, host: string): Promise<AddressInfo>;
  close(): Promise<void>;
}

class WsRoomSocket implements RoomSocket {
  private closeRequested = false;

  constructor(
    private readonly ws: WebSocket,
    private readonly logger: Logger,
  ) {}

  isOpen(): boolean {
    return this.ws.readyState === WebSocket.OPEN;
  }

  send(data: Uint8Array): void {
    if (!this.isOpen()) throw new Error("WebSocket is not open");
    this.ws.send(data, (error) => {
      if (error) {
        this.logger.debug({ err: error }, "WebSocket send callback failed");
      }
    });
  }

  close(code: number, reason: string): void {
    if (this.closeRequested) return;
    this.closeRequested = true;
    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
      this.ws.close(code, truncateCloseReason(reason));
    }
  }
}

export function createRealtimeServer(options: RealtimeServerOptions): RealtimeServer {
  const logger = options.logger.child({ component: "realtime-server" });
  const roomManager = new RoomManager(options.store, {
    ...options,
    logger: options.logger,
  });
  const maxPayload = options.maxUpdateBytes + MAX_AWARENESS_BYTES + 4096;
  let closing = false;
  let closePromise: Promise<void> | null = null;

  const httpServer = createServer((request, response) => {
    void handleHttpRequest(request, response, options.readiness, logger);
  });

  httpServer.on("clientError", (error, socket) => {
    logger.debug({ err: error }, "HTTP client error");
    if (socket.writable) {
      socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    }
  });

  const wsServer = new WebSocketServer({
    noServer: true,
    maxPayload,
    clientTracking: true,
    handleProtocols: (protocols) => (protocols.has(WEBSOCKET_PROTOCOL) ? WEBSOCKET_PROTOCOL : false),
  });

  wsServer.on("error", (error) => {
    logger.error({ err: error }, "WebSocketServer error");
  });

  httpServer.on("upgrade", (request, socket, head) => {
    void handleUpgrade(request, socket, head);
  });

  async function handleUpgrade(
    request: IncomingMessage,
    socket: import("node:stream").Duplex,
    head: Buffer,
  ): Promise<void> {
    socket.on("error", (error) => {
      logger.debug({ err: error }, "upgrade socket error");
    });

    try {
      if (closing) {
        rejectUpgrade(socket, 503, "server_shutting_down", "Server is shutting down");
        return;
      }

      const url = parseRequestUrl(request);
      if (!url) {
        rejectUpgrade(socket, 400, "bad_request", "Malformed request URL");
        return;
      }

      if (request.headers.origin && request.headers.origin !== options.webOrigin) {
        rejectUpgrade(socket, 403, "forbidden_origin", "WebSocket origin is not allowed");
        return;
      }

      const pathMatch = UUID_PATH.exec(url.pathname);
      if (!pathMatch?.[1]) {
        rejectUpgrade(socket, 404, "not_found", "WebSocket endpoint not found");
        return;
      }

      const documentId = pathMatch[1];
      if (!documentIdSchema.safeParse(documentId).success) {
        rejectUpgrade(socket, 400, "validation_error", "documentId must be a UUID");
        return;
      }

      const token = extractToken(request);
      if (!token) {
        rejectUpgrade(
          socket,
          401,
          "unauthorized",
          "Provide a bearer token via Authorization or the Sec-WebSocket-Protocol header",
        );
        return;
      }

      let claims;
      try {
        claims = await withTimeout(options.tokens.verify(token), options.authTimeoutMs);
      } catch (error) {
        if (error instanceof TokenError) {
          rejectUpgrade(socket, 401, "unauthorized", "Access token is invalid or expired");
          return;
        }
        logger.warn({ err: error }, "WebSocket token verification failed");
        rejectUpgrade(socket, 401, "unauthorized", "Authentication failed");
        return;
      }

      let access;
      try {
        access = await withTimeout(
          options.store.getDocumentAccess(documentId, claims.sub),
          options.authTimeoutMs,
        );
      } catch (error) {
        logger.error({ err: error, documentId }, "document authorization lookup failed");
        rejectUpgrade(socket, 503, "service_unavailable", "Authorization service unavailable");
        return;
      }

      if (!access) {
        rejectUpgrade(socket, 403, "forbidden", "You do not have access to this document");
        return;
      }

      if (socket.destroyed) return;

      try {
        wsServer.handleUpgrade(request, socket, head, (ws) => {
          void establishConnection(ws, {
            documentId,
            userId: claims.sub,
            displayName: claims.name,
            email: claims.email,
            role: access.role,
            expiresAt: claims.expiresAt,
          });
        });
      } catch (error) {
        logger.warn({ err: error }, "WebSocket upgrade failed");
        rejectUpgrade(socket, 400, "bad_request", "WebSocket upgrade failed");
      }
    } catch (error) {
      logger.error({ err: error }, "unhandled WebSocket upgrade error");
      rejectUpgrade(socket, 500, "internal_error", "Internal server error");
    }
  }

  async function establishConnection(
    ws: WebSocket,
    actor: {
      documentId: string;
      userId: string;
      displayName: string;
      email: string;
      role: "owner" | "editor" | "viewer";
      expiresAt: number;
    },
  ): Promise<void> {
    const roomSocket = new WsRoomSocket(ws, logger);
    let session: RoomClient | null = null;

    ws.on("error", (error) => {
      logger.debug({ err: error, documentId: actor.documentId }, "client WebSocket error");
    });

    ws.on("close", (code, reason) => {
      logger.debug(
        {
          documentId: actor.documentId,
          userId: actor.userId,
          code,
          reason: reason.toString(),
        },
        "client WebSocket closed",
      );
      if (session) {
        void roomManager.disconnect(session).catch((error: unknown) => {
          logger.error({ err: error, documentId: actor.documentId }, "room client disconnect failed");
        });
      }
    });

    try {
      ws.pause();
      session = await roomManager.connect({
        documentId: actor.documentId,
        actor,
        socket: roomSocket,
      });

      if (ws.readyState !== WebSocket.OPEN) {
        await roomManager.disconnect(session);
        return;
      }

      ws.on("message", (data, isBinary) => {
        if (!session) return;
        void roomManager
          .handleMessage(session, toUint8Array(data as Buffer), isBinary)
          .catch((error: unknown) => {
            logger.error(
              { err: error, documentId: actor.documentId, userId: actor.userId },
              "WebSocket message handling failed",
            );
          });
      });

      ws.resume();
      logger.debug(
        { documentId: actor.documentId, userId: actor.userId, role: actor.role },
        "WebSocket connection established",
      );
    } catch (error) {
      if (session) {
        await roomManager.disconnect(session).catch(() => undefined);
      }
      const code =
        error instanceof RoomManagerShuttingDownError
          ? CLOSE_CODE.SERVER_RESTART
          : CLOSE_CODE.INTERNAL_ERROR;
      logger.error(
        { err: error, documentId: actor.documentId, userId: actor.userId },
        "failed to establish realtime session",
      );
      roomSocket.close(code, "Could not open document room");
    }
  }

  async function close(): Promise<void> {
    if (closePromise) return closePromise;
    closing = true;
    closePromise = (async () => {
      const httpClosed = new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
      });

      for (const ws of wsServer.clients) {
        ws.close(CLOSE_CODE.SERVER_RESTART, "Server restarting");
      }

      await roomManager.shutdown();

      for (const ws of wsServer.clients) {
        ws.terminate();
      }

      httpServer.closeIdleConnections?.();
      httpServer.closeAllConnections?.();
      await httpClosed;

      await new Promise<void>((resolve) => {
        wsServer.close(() => resolve());
      });

      if (!httpServer.listening) {
        // httpServer.close() invokes its callback without error for a server
        // that has never listened on current Node versions. This branch keeps
        // the behavior explicit for older runtimes.
        return;
      }
    })();

    return closePromise;
  }

  return {
    httpServer,
    roomManager,
    listen(port: number, host: string): Promise<AddressInfo> {
      return new Promise((resolve, reject) => {
        const onError = (error: Error): void => {
          httpServer.off("listening", onListening);
          reject(error);
        };
        const onListening = (): void => {
          httpServer.off("error", onError);
          resolve(httpServer.address() as AddressInfo);
        };
        httpServer.once("error", onError);
        httpServer.once("listening", onListening);
        httpServer.listen(port, host);
      });
    },
    close,
  };
}

function parseRequestUrl(request: IncomingMessage): URL | null {
  try {
    return new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  } catch {
    return null;
  }
}

function extractToken(request: IncomingMessage): string | null {
  const authorization = request.headers.authorization;
  if (authorization) {
    const match = /^Bearer\s+([^\s]+)$/i.exec(authorization);
    return match?.[1] ?? null;
  }

  const protocolHeader = request.headers["sec-websocket-protocol"];
  const protocols = typeof protocolHeader === "string" ? protocolHeader.split(",") : [];
  for (const rawProtocol of protocols) {
    const protocol = rawProtocol.trim();
    if (protocol.startsWith(BEARER_PROTOCOL_PREFIX)) {
      const token = protocol.slice(BEARER_PROTOCOL_PREFIX.length);
      if (token.length > 0) return token;
    }
  }
  return null;
}

async function handleHttpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  readiness: () => Promise<void>,
  logger: Logger,
): Promise<void> {
  const url = parseRequestUrl(request);
  if (!url || request.method !== "GET") {
    sendJson(response, 404, { error: { code: "not_found", message: "Not found" } });
    return;
  }

  if (url.pathname === "/healthz") {
    sendJson(response, 200, { status: "ok", service: "trellis-realtime" });
    return;
  }

  if (url.pathname === "/readyz") {
    try {
      await readiness();
      sendJson(response, 200, { status: "ready" });
    } catch (error) {
      logger.warn({ err: error }, "realtime readiness check failed");
      sendJson(response, 503, { status: "not_ready" });
    }
    return;
  }

  if (/^\/ws\/documents\/[^/]+$/.test(url.pathname)) {
    sendJson(response, 426, {
      error: { code: "upgrade_required", message: "Use a WebSocket upgrade for this path" },
    });
    return;
  }

  sendJson(response, 404, { error: { code: "not_found", message: "Not found" } });
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(payload);
}

function rejectUpgrade(
  socket: {
    writable: boolean;
    destroyed: boolean;
    write: (chunk: string) => boolean;
    destroy: () => void;
  },
  status: number,
  code: string,
  message: string,
): void {
  if (socket.destroyed || !socket.writable) return;
  const body = JSON.stringify({ error: { code, message } });
  const header = [
    `HTTP/1.1 ${status} ${statusText(status)}`,
    "Connection: close",
    "Content-Type: application/json; charset=utf-8",
    `Content-Length: ${Buffer.byteLength(body)}`,
    ...(status === 401 ? ["WWW-Authenticate: Bearer"] : []),
    "",
    body,
  ].join("\r\n");
  try {
    socket.write(header);
  } finally {
    socket.destroy();
  }
}

function statusText(status: number): string {
  switch (status) {
    case 400:
      return "Bad Request";
    case 401:
      return "Unauthorized";
    case 403:
      return "Forbidden";
    case 404:
      return "Not Found";
    case 500:
      return "Internal Server Error";
    case 503:
      return "Service Unavailable";
    default:
      return "Error";
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Operation timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
