import type { TokenService } from "@trellis/auth";
import type { CommentRepository } from "@trellis/db";
import {
  createCommentSchema,
  resolveCommentSchema,
  type CommentDto,
} from "@trellis/shared";
import type { FastifyInstance } from "fastify";

import { NotFoundApiError, ValidationError } from "../lib/errors.js";
import { parseBody, parseUuid, requireAuth } from "../lib/http.js";

export interface CommentRouteDependencies {
  commentRepository: CommentRepository;
  tokens: TokenService;
}

/**
 * Canvas comments.
 *
 * Read: any workspace member (viewer included).
 * Write: owner or editor only. The repository enforces this inside the same
 * statement that writes, so a viewer's POST inserts nothing rather than
 * inserting and then being rejected.
 */
export function registerCommentRoutes(
  app: FastifyInstance,
  dependencies: CommentRouteDependencies,
): void {
  const { commentRepository, tokens } = dependencies;

  app.get("/v1/documents/:documentId/comments", async (request) => {
    const claims = await requireAuth(request, tokens);
    const documentId = parseUuid(readParam(request.params, "documentId"), "documentId");

    const comments = await commentRepository.listComments(documentId, claims.sub);
    return { comments: comments.map(toCommentDto) };
  });

  app.post("/v1/documents/:documentId/comments", async (request, reply) => {
    const claims = await requireAuth(request, tokens);
    const documentId = parseUuid(readParam(request.params, "documentId"), "documentId");
    const body = parseBody(createCommentSchema, request.body);

    if (!Number.isFinite(body.x) || !Number.isFinite(body.y)) {
      throw new ValidationError("Comment coordinates must be finite numbers");
    }

    const comment = await commentRepository.createComment({
      documentId,
      authorId: claims.sub,
      x: body.x,
      y: body.y,
      content: body.content,
      parentCommentId: body.parentCommentId ?? null,
    });

    return reply.status(201).send({ comment: toCommentDto(comment) });
  });

  app.patch("/v1/comments/:commentId/resolve", async (request) => {
    const claims = await requireAuth(request, tokens);
    const commentId = parseUuid(readParam(request.params, "commentId"), "commentId");
    const body = parseBody(resolveCommentSchema, request.body);

    const comment = await commentRepository.setResolved({
      commentId,
      userId: claims.sub,
      resolved: body.resolved,
    });

    return { comment: toCommentDto(comment) };
  });

  app.delete("/v1/comments/:commentId", async (request, reply) => {
    const claims = await requireAuth(request, tokens);
    const commentId = parseUuid(readParam(request.params, "commentId"), "commentId");
    await commentRepository.deleteComment(commentId, claims.sub);
    return reply.status(204).send();
  });
}

function toCommentDto(comment: {
  id: string;
  documentId: string;
  authorId: string;
  authorName: string;
  parentCommentId: string | null;
  x: number;
  y: number;
  content: string;
  resolved: boolean;
  createdAt: string;
  updatedAt: string;
}): CommentDto {
  return {
    id: comment.id,
    documentId: comment.documentId,
    authorId: comment.authorId,
    authorName: comment.authorName,
    parentCommentId: comment.parentCommentId,
    x: comment.x,
    y: comment.y,
    content: comment.content,
    resolved: comment.resolved,
    createdAt: comment.createdAt,
    updatedAt: comment.updatedAt,
  };
}

function readParam(params: unknown, key: string): string {
  const record = typeof params === "object" && params !== null ? (params as Record<string, unknown>) : {};
  const value = record[key];
  if (typeof value !== "string") throw new NotFoundApiError(`${key} is required`);
  return value;
}
