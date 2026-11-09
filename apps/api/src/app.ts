import { randomUUID } from "node:crypto";

import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import type { TokenService } from "@trellis/auth";
import {
  AssetRepository,
  AuthRepository,
  CommentRepository,
  DataError,
  WorkspaceRepository,
  pingDatabase,
  type DatabaseOptions,
  type DatabasePool,
} from "@trellis/db";
import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyServerOptions,
} from "fastify";
import { ZodError } from "zod";

import { ApiError } from "./lib/errors.js";
import type { StorageAdapter } from "./lib/storage.js";
import { registerAssetRoutes } from "./routes/asset-routes.js";
import { registerAuthRoutes } from "./routes/auth-routes.js";
import { registerCommentRoutes } from "./routes/comment-routes.js";
import { registerDocumentRoutes } from "./routes/document-routes.js";
import { registerTemplateRoutes } from "./routes/template-routes.js";
import { registerWorkspaceRoutes } from "./routes/workspace-routes.js";

export interface ApiDependencies {
  pool: DatabasePool;
  authRepository: AuthRepository;
  workspaceRepository: WorkspaceRepository;
  assetRepository: AssetRepository;
  commentRepository: CommentRepository;
  storage: StorageAdapter;
  tokens: TokenService;
  webOrigin: string;
  logger?: FastifyServerOptions["logger"];
}

export interface BuildApiOptions {
  deps: ApiDependencies;
  logger?: FastifyServerOptions["logger"];
}

export async function buildApi(options: BuildApiOptions): Promise<FastifyInstance> {
  const { deps } = options;
  const app = Fastify({
    logger: options.logger ?? deps.logger ?? false,
    bodyLimit: 1024 * 1024,
    requestIdHeader: "x-request-id",
    genReqId: () => randomUUID(),
    trustProxy: false,
  });

  await app.register(helmet, {
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: "same-site" },
  });
  await app.register(cors, {
    origin: deps.webOrigin,
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["authorization", "content-type", "x-request-id"],
    exposedHeaders: ["x-request-id"],
    credentials: false,
    maxAge: 600,
  });
  await app.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: "1 minute",
  });

  /**
   * Binary body parser for asset uploads.
   *
   * Fastify ships parsers for JSON and text only. Without this, a PUT of
   * image/png is rejected with 415 before the route handler runs, which makes
   * the local-storage upload path unusable. The parser buffers the raw bytes
   * into a Buffer; the route's own bodyLimit caps the size at the asset limit.
   */
  app.addContentTypeParser(
    ["image/png", "image/jpeg", "image/webp", "image/svg+xml", "application/octet-stream"],
    { parseAs: "buffer" },
    (_request, body, done) => {
      done(null, body);
    },
  );

  app.get("/healthz", async () => ({ status: "ok" }));
  app.get("/readyz", async (_request, reply) => {
    try {
      await pingDatabase(deps.pool);
      return { status: "ready" };
    } catch (error) {
      app.log.error({ err: error }, "database readiness check failed");
      return reply.status(503).send({ status: "not_ready" });
    }
  });

  registerAuthRoutes(app, {
    authRepository: deps.authRepository,
    tokens: deps.tokens,
  });
  registerWorkspaceRoutes(app, {
    workspaceRepository: deps.workspaceRepository,
    tokens: deps.tokens,
  });
  registerDocumentRoutes(app, {
    workspaceRepository: deps.workspaceRepository,
    tokens: deps.tokens,
  });
  registerAssetRoutes(app, {
    assetRepository: deps.assetRepository,
    storage: deps.storage,
    tokens: deps.tokens,
  });
  registerCommentRoutes(app, {
    commentRepository: deps.commentRepository,
    tokens: deps.tokens,
  });
  registerTemplateRoutes(app, {
    workspaceRepository: deps.workspaceRepository,
    pool: deps.pool,
    tokens: deps.tokens,
  });

  app.setNotFoundHandler((request, reply) => {
    return reply.status(404).send({
      error: {
        code: "not_found",
        message: "Route not found",
        requestId: request.id,
      },
    });
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    const requestId = request.id;

    if (error instanceof ZodError) {
      return sendError(reply, 400, "validation_error", "Invalid request", requestId);
    }
    if (error instanceof ApiError) {
      return sendError(reply, error.statusCode, error.code, error.message, requestId);
    }
    if (error instanceof DataError) {
      switch (error.code) {
        case "not_found":
          return sendError(reply, 404, "not_found", error.message, requestId);
        case "forbidden":
          return sendError(reply, 403, "forbidden", error.message, requestId);
        case "conflict":
          return sendError(reply, 409, "conflict", error.message, requestId);
        case "invalid_token":
          return sendError(reply, 400, "invalid_token", error.message, requestId);
        default:
          request.log.error({ err: error }, "data layer failure");
          return sendError(reply, 500, "internal_error", "Internal server error", requestId);
      }
    }

    const statusCode = typeof error.statusCode === "number" ? error.statusCode : 500;
    if (statusCode === 429) {
      return sendError(reply, 429, "rate_limited", "Too many requests", requestId);
    }
    if (statusCode >= 400 && statusCode < 500) {
      return sendError(
        reply,
        statusCode,
        "bad_request",
        statusCode === 400 ? "Malformed request" : error.message,
        requestId,
      );
    }

    request.log.error({ err: error }, "unhandled API error");
    return sendError(reply, 500, "internal_error", "Internal server error", requestId);
  });

  return app;
}

function sendError(
  reply: { status: (code: number) => { send: (payload: unknown) => unknown } },
  statusCode: number,
  code: string,
  message: string,
  requestId: string,
): unknown {
  return reply.status(statusCode).send({
    error: {
      code,
      message,
      requestId,
    },
  });
}

export type ApiAppDependencies = ApiDependencies;
export type ApiDatabaseOptions = DatabaseOptions;
