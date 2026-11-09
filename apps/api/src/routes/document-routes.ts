import type { TokenService } from "@trellis/auth";
import type { WorkspaceRepository } from "@trellis/db";
import { renameDocumentSchema } from "@trellis/shared";
import type { FastifyInstance } from "fastify";

import { NotFoundApiError } from "../lib/errors.js";
import { parseBody, parseUuid, requireAuth } from "../lib/http.js";
import { toDocumentDto } from "./mappers.js";

export interface DocumentRouteDependencies {
  workspaceRepository: WorkspaceRepository;
  tokens: TokenService;
}

export function registerDocumentRoutes(
  app: FastifyInstance,
  dependencies: DocumentRouteDependencies,
): void {
  const { workspaceRepository, tokens } = dependencies;

  app.get("/v1/documents/:documentId", async (request) => {
    const claims = await requireAuth(request, tokens);
    const documentId = parseDocumentId(request.params);
    const document = await workspaceRepository.getDocument(documentId, claims.sub);
    if (!document) throw new NotFoundApiError("Document not found");
    return { document: toDocumentDto(document) };
  });

  app.patch("/v1/documents/:documentId", async (request) => {
    const claims = await requireAuth(request, tokens);
    const documentId = parseDocumentId(request.params);
    const body = parseBody(renameDocumentSchema, request.body);
    const document = await workspaceRepository.renameDocument({
      documentId,
      userId: claims.sub,
      title: body.title,
    });
    return { document: toDocumentDto(document) };
  });

  app.delete("/v1/documents/:documentId", async (request, reply) => {
    const claims = await requireAuth(request, tokens);
    const documentId = parseDocumentId(request.params);
    await workspaceRepository.deleteDocument({ documentId, userId: claims.sub });
    return reply.status(204).send();
  });
}

function parseDocumentId(params: unknown): string {
  const raw = typeof params === "object" && params !== null ? (params as Record<string, unknown>) : {};
  if (typeof raw["documentId"] !== "string") throw new NotFoundApiError();
  return parseUuid(raw["documentId"], "documentId");
}
