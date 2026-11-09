import { createHash, randomBytes } from "node:crypto";

import type { TokenService } from "@trellis/auth";
import type { WorkspaceRepository } from "@trellis/db";
import {
  acceptInvitationSchema,
  createDocumentSchema,
  createInvitationSchema,
  createWorkspaceSchema,
  type InvitationDto,
} from "@trellis/shared";
import type { FastifyInstance } from "fastify";

import { NotFoundApiError } from "../lib/errors.js";
import { parseBody, parseUuid, requireAuth } from "../lib/http.js";
import { toDocumentDto, toMemberDto, toWorkspaceDto } from "./mappers.js";

export interface WorkspaceRouteDependencies {
  workspaceRepository: WorkspaceRepository;
  tokens: TokenService;
}

export function registerWorkspaceRoutes(
  app: FastifyInstance,
  dependencies: WorkspaceRouteDependencies,
): void {
  const { workspaceRepository, tokens } = dependencies;

  app.get("/v1/workspaces", async (request) => {
    const claims = await requireAuth(request, tokens);
    const workspaces = await workspaceRepository.listWorkspaces(claims.sub);
    return { workspaces: workspaces.map(toWorkspaceDto) };
  });

  app.post("/v1/workspaces", async (request, reply) => {
    const claims = await requireAuth(request, tokens);
    const body = parseBody(createWorkspaceSchema, request.body);
    const slug = makeWorkspaceSlug(body.name);
    const workspace = await workspaceRepository.createWorkspace({
      ownerId: claims.sub,
      name: body.name,
      slug,
    });
    return reply.status(201).send({ workspace: toWorkspaceDto(workspace) });
  });

  app.get("/v1/workspaces/:workspaceId", async (request) => {
    const claims = await requireAuth(request, tokens);
    const { workspaceId } = parseWorkspaceParams(request.params);
    const workspace = await workspaceRepository.getWorkspace(workspaceId, claims.sub);
    if (!workspace) throw new NotFoundApiError("Workspace not found");
    return { workspace: toWorkspaceDto(workspace) };
  });

  app.get("/v1/workspaces/:workspaceId/members", async (request) => {
    const claims = await requireAuth(request, tokens);
    const { workspaceId } = parseWorkspaceParams(request.params);
    const members = await workspaceRepository.listMembers(workspaceId, claims.sub);
    return { members: members.map(toMemberDto) };
  });

  app.get("/v1/workspaces/:workspaceId/documents", async (request) => {
    const claims = await requireAuth(request, tokens);
    const { workspaceId } = parseWorkspaceParams(request.params);
    const documents = await workspaceRepository.listDocuments(workspaceId, claims.sub);
    return { documents: documents.map(toDocumentDto) };
  });

  app.post("/v1/workspaces/:workspaceId/documents", async (request, reply) => {
    const claims = await requireAuth(request, tokens);
    const { workspaceId } = parseWorkspaceParams(request.params);
    const body = parseBody(createDocumentSchema, request.body);
    const document = await workspaceRepository.createDocument({
      workspaceId,
      userId: claims.sub,
      title: body.title,
    });
    return reply.status(201).send({ document: toDocumentDto(document) });
  });

  app.post(
    "/v1/workspaces/:workspaceId/invitations",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const claims = await requireAuth(request, tokens);
      const { workspaceId } = parseWorkspaceParams(request.params);
      const body = parseBody(createInvitationSchema, request.body);

      const token = randomBytes(32).toString("base64url");
      const tokenHash = hashInvitationToken(token);
      const expiresAt = new Date(Date.now() + body.expiresInHours * 60 * 60 * 1000);
      const invitation = await workspaceRepository.createInvitation({
        workspaceId,
        invitedBy: claims.sub,
        email: body.email,
        role: body.role,
        tokenHash,
        expiresAt,
      });

      const response: InvitationDto = {
        id: invitation.id,
        workspaceId: invitation.workspaceId,
        email: invitation.email,
        role: invitation.role,
        expiresAt: invitation.expiresAt,
        createdAt: invitation.createdAt,
        token,
      };
      await app.log.info(
        { invitationId: invitation.id, workspaceId, invitedBy: claims.sub },
        "workspace invitation created",
      );
      return reply.status(201).send({ invitation: response });
    },
  );

  app.post(
    "/v1/invitations/accept",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (request) => {
      const claims = await requireAuth(request, tokens);
      const body = parseBody(acceptInvitationSchema, request.body);
      const workspace = await workspaceRepository.acceptInvitation({
        tokenHash: hashInvitationToken(body.token),
        userId: claims.sub,
      });
      return { workspace: toWorkspaceDto(workspace) };
    },
  );
}

function parseWorkspaceParams(params: unknown): { workspaceId: string } {
  const raw = typeof params === "object" && params !== null ? (params as Record<string, unknown>) : {};
  if (typeof raw["workspaceId"] !== "string") throw new NotFoundApiError();
  return { workspaceId: parseUuid(raw["workspaceId"], "workspaceId") };
}

function makeWorkspaceSlug(name: string): string {
  const base = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  const suffix = randomBytes(4).toString("hex");
  return `${base || "workspace"}-${suffix}`;
}

function hashInvitationToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
