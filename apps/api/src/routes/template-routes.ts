import { randomUUID } from "node:crypto";

import type { TokenService } from "@trellis/auth";
import { withTransaction, type WorkspaceRepository, type DatabasePool } from "@trellis/db";
import {
  instantiateTemplateSchema,
  type DocumentDto,
  type TemplateDto,
} from "@trellis/shared";
import type { FastifyInstance } from "fastify";

import { NotFoundApiError } from "../lib/errors.js";
import { parseBody, parseUuid, requireAuth } from "../lib/http.js";
import { encodeTemplateState, findTemplate, listTemplates } from "../lib/templates.js";
import { toDocumentDto } from "./mappers.js";

export interface TemplateRouteDependencies {
  workspaceRepository: WorkspaceRepository;
  pool: DatabasePool;
  tokens: TokenService;
}

export function registerTemplateRoutes(
  app: FastifyInstance,
  dependencies: TemplateRouteDependencies,
): void {
  const { workspaceRepository, pool, tokens } = dependencies;

  app.get("/v1/templates", async (request) => {
    await requireAuth(request, tokens);
    const templates: TemplateDto[] = listTemplates();
    return { templates };
  });

  /**
   * Create a document pre-populated from a template.
   *
   * The document row and its seed snapshot are written in one transaction, so a
   * client that opens the new room immediately either sees the template or sees
   * nothing at all. `through_update_id = 0` is correct: no incremental updates
   * exist, and `loadForColdStart` selects `id > through_update_id`, which
   * matches every future update.
   */
  app.post("/v1/workspaces/:workspaceId/documents/from-template", async (request, reply) => {
    const claims = await requireAuth(request, tokens);
    const workspaceId = parseUuid(readParam(request.params, "workspaceId"), "workspaceId");
    const body = parseBody(instantiateTemplateSchema, request.body);

    const seed = findTemplate(body.templateId);
    if (!seed) throw new NotFoundApiError("Template not found");

    const documentId = randomUUID();
    const title = body.title ?? seed.name;
    const encoded = encodeTemplateState(seed);

    const document = await withTransaction(pool, async (client) => {
      // Reuse the repository's role-enforcing insert by pre-assigning the id.
      const created = await workspaceRepository.createDocument({
        workspaceId,
        userId: claims.sub,
        title,
        documentId,
      });

      await client.query(
        `INSERT INTO app.document_snapshots
           (document_id, version, state, state_vector, through_update_id, created_by)
         VALUES ($1, 1, $2, $3, 0, $4)`,
        [created.id, Buffer.from(encoded.state), Buffer.from(encoded.stateVector), claims.sub],
      );

      return created;
    });

    request.log.info(
      { documentId: document.id, templateId: seed.id, nodeCount: encoded.nodeCount },
      "instantiated template",
    );

    const dto: DocumentDto = toDocumentDto(document);
    return reply.status(201).send({ document: dto });
  });
}

function readParam(params: unknown, key: string): string {
  const record = typeof params === "object" && params !== null ? (params as Record<string, unknown>) : {};
  const value = record[key];
  if (typeof value !== "string") throw new NotFoundApiError(`${key} is required`);
  return value;
}
