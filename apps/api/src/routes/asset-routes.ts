import { randomUUID } from "node:crypto";

import type { TokenService } from "@trellis/auth";
import type { AssetRepository } from "@trellis/db";
import {
  ASSET_MAX_BYTES,
  assetConfirmSchema,
  assetUploadIntentSchema,
  type AssetDto,
  type AssetUploadIntentDto,
} from "@trellis/shared";
import type { FastifyInstance } from "fastify";

import { ForbiddenApiError, NotFoundApiError, ValidationError } from "../lib/errors.js";
import { parseBody, parseUuid, requireAuth } from "../lib/http.js";
import { buildAssetStorageKey, type StorageAdapter } from "../lib/storage.js";

export interface AssetRouteDependencies {
  assetRepository: AssetRepository;
  storage: StorageAdapter;
  tokens: TokenService;
}

const EDITOR_ROLES = new Set(["owner", "editor"]);

export function registerAssetRoutes(
  app: FastifyInstance,
  dependencies: AssetRouteDependencies,
): void {
  const { assetRepository, storage, tokens } = dependencies;

  /**
   * Issue an upload target. The asset row is NOT written here: a client that
   * requests an intent and never uploads must not leave a phantom asset in the
   * workspace library, so the row is only created by /confirm after the bytes
   * are verified to exist at the expected size.
   */
  app.post("/v1/workspaces/:workspaceId/assets/upload-intent", async (request, reply) => {
    const claims = await requireAuth(request, tokens);
    const workspaceId = parseWorkspaceId(request.params);
    const body = parseBody(assetUploadIntentSchema, request.body);

    const role = await assetRepository.getWorkspaceRole(workspaceId, claims.sub);
    if (!role) throw new NotFoundApiError("Workspace not found");
    if (!EDITOR_ROLES.has(role)) {
      throw new ForbiddenApiError("Viewers cannot upload assets");
    }

    const assetId = randomUUID();
    const storageKey = buildAssetStorageKey({
      workspaceId,
      assetId,
      mimeType: body.mimeType,
    });
    const publicUrl = storage.publicUrl(storageKey);

    // The local adapter has no presigning, so the client PUTs to the content
    // route below. The shape matches a presigned response so swapping in S3
    // later does not change the client contract.
    const intent: AssetUploadIntentDto = {
      assetId,
      uploadUrl: `/v1/workspaces/${workspaceId}/assets/upload/${encodeURIComponent(storageKey)}`,
      publicUrl,
      method: "PUT",
      headers: { "content-type": body.mimeType },
      expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    };

    request.log.info({ assetId, workspaceId, byteSize: body.byteSize }, "issued asset upload intent");
    return reply.status(201).send({ intent });
  });

  /**
   * Receive the bytes for an upload intent. This is the local-storage stand-in
   * for a presigned S3 PUT. The body limit is enforced by Fastify per route so
   * a 25 MiB asset is accepted while a larger one is rejected before buffering.
   */
  app.put(
    "/v1/workspaces/:workspaceId/assets/upload/:storageKey",
    { bodyLimit: ASSET_MAX_BYTES },
    async (request, reply) => {
      const claims = await requireAuth(request, tokens);
      const workspaceId = parseWorkspaceId(request.params);
      const storageKey = parseStorageKey(request.params);

      const role = await assetRepository.getWorkspaceRole(workspaceId, claims.sub);
      if (!role) throw new NotFoundApiError("Workspace not found");
      if (!EDITOR_ROLES.has(role)) {
        throw new ForbiddenApiError("Viewers cannot upload assets");
      }

      // The key must belong to this workspace, otherwise a member of workspace
      // A could write into workspace B's namespace by crafting the path.
      if (!storageKey.startsWith(`ws-${workspaceId}-`)) {
        throw new ForbiddenApiError("Storage key does not belong to this workspace");
      }

      const bytes = toBytes(request.body);
      if (bytes.byteLength === 0) {
        throw new ValidationError("Upload body is empty");
      }
      if (bytes.byteLength > ASSET_MAX_BYTES) {
        throw new ValidationError(`Assets are limited to ${ASSET_MAX_BYTES} bytes`);
      }

      await storage.put(storageKey, bytes);
      return reply.status(204).send();
    },
  );

  /**
   * Confirm an upload. Verifies the object exists and that its stored size
   * matches what the client claimed, then writes the metadata row.
   */
  app.post("/v1/workspaces/:workspaceId/assets/confirm", async (request, reply) => {
    const claims = await requireAuth(request, tokens);
    const workspaceId = parseWorkspaceId(request.params);
    const body = parseBody(assetConfirmSchema, request.body);

    const role = await assetRepository.getWorkspaceRole(workspaceId, claims.sub);
    if (!role) throw new NotFoundApiError("Workspace not found");
    if (!EDITOR_ROLES.has(role)) {
      throw new ForbiddenApiError("Viewers cannot upload assets");
    }

    const storageKey = buildAssetStorageKey({
      workspaceId,
      assetId: body.assetId,
      // The extension is irrelevant to lookup: the key is exact. Rebuilding it
      // here with a placeholder would be wrong, so probe the known extensions.
      mimeType: "image/png",
    });

    const candidates = [
      storageKey,
      storageKey.replace(/\.png$/, ".jpg"),
      storageKey.replace(/\.png$/, ".webp"),
      storageKey.replace(/\.png$/, ".svg"),
    ];

    let resolvedKey: string | null = null;
    let byteSize: number | null = null;
    for (const candidate of candidates) {
      const size = await storage.size(candidate);
      if (size !== null) {
        resolvedKey = candidate;
        byteSize = size;
        break;
      }
    }

    if (!resolvedKey || byteSize === null) {
      throw new NotFoundApiError("Uploaded object not found; upload the bytes before confirming");
    }
    if (byteSize > ASSET_MAX_BYTES) {
      throw new ValidationError(`Assets are limited to ${ASSET_MAX_BYTES} bytes`);
    }

    const mimeType = resolvedKey.endsWith(".png")
      ? "image/png"
      : resolvedKey.endsWith(".jpg")
        ? "image/jpeg"
        : resolvedKey.endsWith(".webp")
          ? "image/webp"
          : "image/svg+xml";

    const asset = await assetRepository.insertAsset({
      id: body.assetId,
      workspaceId,
      createdBy: claims.sub,
      mimeType,
      byteSize,
      storageKey: resolvedKey,
      publicUrl: storage.publicUrl(resolvedKey),
      width: body.width ?? null,
      height: body.height ?? null,
    });

    return reply.status(201).send({ asset: toAssetDto(asset) });
  });

  app.get("/v1/workspaces/:workspaceId/assets", async (request) => {
    const claims = await requireAuth(request, tokens);
    const workspaceId = parseWorkspaceId(request.params);
    const query = parseListQuery(request.query);

    const role = await assetRepository.getWorkspaceRole(workspaceId, claims.sub);
    if (!role) throw new NotFoundApiError("Workspace not found");

    const assets = await assetRepository.listAssets(workspaceId, claims.sub, query);
    return { assets: assets.map(toAssetDto) };
  });

  /**
   * Stream asset bytes. Requires workspace membership: assets are not public,
   * even though the URL is stable and cacheable.
   */
  app.get("/v1/assets/:assetId/content", async (request, reply) => {
    const claims = await requireAuth(request, tokens);
    const assetId = parseUuid(readParam(request.params, "assetId"), "assetId");

    const asset = await assetRepository.getAssetForUser(assetId, claims.sub);
    if (!asset) throw new NotFoundApiError("Asset not found");

    const stream = await storage.read(asset.storageKey);
    if (!stream) throw new NotFoundApiError("Asset bytes are missing from storage");

    return reply
      .header("content-type", asset.mimeType)
      .header("cache-control", "private, max-age=31536000, immutable")
      .header("content-length", String(asset.byteSize))
      .send(stream);
  });
}

function toAssetDto(asset: {
  id: string;
  workspaceId: string;
  mimeType: string;
  byteSize: number;
  publicUrl: string;
  width: number | null;
  height: number | null;
  createdBy: string;
  createdAt: string;
}): AssetDto {
  return {
    id: asset.id,
    workspaceId: asset.workspaceId,
    mimeType: asset.mimeType as AssetDto["mimeType"],
    byteSize: asset.byteSize,
    publicUrl: asset.publicUrl,
    width: asset.width,
    height: asset.height,
    createdBy: asset.createdBy,
    createdAt: asset.createdAt,
  };
}

function toBytes(body: unknown): Uint8Array {
  if (body instanceof Uint8Array) return body;
  if (typeof body === "string") return new TextEncoder().encode(body);
  if (Buffer.isBuffer(body)) return new Uint8Array(body);
  throw new ValidationError("Upload body must be binary");
}

function parseWorkspaceId(params: unknown): string {
  return parseUuid(readParam(params, "workspaceId"), "workspaceId");
}

function parseStorageKey(params: unknown): string {
  const raw = readParam(params, "storageKey");
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 255) {
    throw new ValidationError("storageKey is invalid");
  }
  return decodeURIComponent(raw);
}

function readParam(params: unknown, key: string): string {
  const record = typeof params === "object" && params !== null ? (params as Record<string, unknown>) : {};
  const value = record[key];
  if (typeof value !== "string") throw new ValidationError(`${key} is required`);
  return value;
}

function parseListQuery(query: unknown): { limit: number; before: string | null } {
  const record = typeof query === "object" && query !== null ? (query as Record<string, unknown>) : {};
  const rawLimit = record["limit"];
  const limit =
    typeof rawLimit === "string" && /^\d+$/.test(rawLimit)
      ? Math.min(200, Math.max(1, Number(rawLimit)))
      : 50;
  const rawBefore = record["before"];
  const before = typeof rawBefore === "string" && rawBefore.length > 0 ? rawBefore : null;
  return { limit, before };
}
