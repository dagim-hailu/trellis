import {
  ASSET_MAX_BYTES,
  ASSET_MIME_TYPES,
} from "@trellis/shared";
import type {
  ApiErrorBody,
  AssetDto,
  AssetUploadIntentDto,
  AuthResponseDto,
  CommentDto,
  DocumentDto,
  TemplateDto,
  TemplateId,
  UserDto,
  WorkspaceDto,
} from "@trellis/shared";

import { API_URL } from "./env";

export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
    this.code = code;
  }
}

interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  token?: string;
  body?: unknown;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (options.token) headers.authorization = `Bearer ${options.token}`;

  const requestInit: RequestInit = {
    method: options.method ?? "GET",
    headers,
    cache: "no-store",
  };
  if (options.body !== undefined) requestInit.body = JSON.stringify(options.body);

  let response: Response;
  try {
    response = await fetch(`${API_URL}${path}`, requestInit);
  } catch {
    throw new ApiRequestError(
      0,
      "network_error",
      "Cannot reach the Trellis API. Check that the API is running.",
    );
  }

  if (response.status === 204) return undefined as T;

  const contentType = response.headers.get("content-type") ?? "";
  const payload = contentType.includes("application/json")
    ? ((await response.json().catch(() => null)) as unknown)
    : null;

  if (!response.ok) {
    const errorBody = payload as ApiErrorBody | null;
    throw new ApiRequestError(
      response.status,
      errorBody?.error?.code ?? "request_failed",
      errorBody?.error?.message ?? `Request failed with status ${response.status}`,
    );
  }
  return payload as T;
}

export async function login(input: {
  email: string;
  password: string;
}): Promise<AuthResponseDto> {
  return request<AuthResponseDto>("/v1/auth/login", { method: "POST", body: input });
}

export async function register(input: {
  email: string;
  password: string;
  displayName: string;
}): Promise<AuthResponseDto> {
  return request<AuthResponseDto>("/v1/auth/register", { method: "POST", body: input });
}

export async function getMe(token: string): Promise<UserDto> {
  const response = await request<{ user: UserDto }>("/v1/me", { token });
  return response.user;
}

export async function listWorkspaces(token: string): Promise<WorkspaceDto[]> {
  const response = await request<{ workspaces: WorkspaceDto[] }>("/v1/workspaces", { token });
  return response.workspaces;
}

export async function createWorkspace(token: string, name: string): Promise<WorkspaceDto> {
  const response = await request<{ workspace: WorkspaceDto }>("/v1/workspaces", {
    method: "POST",
    token,
    body: { name },
  });
  return response.workspace;
}

export async function listDocuments(
  token: string,
  workspaceId: string,
): Promise<DocumentDto[]> {
  const response = await request<{ documents: DocumentDto[] }>(
    `/v1/workspaces/${encodeURIComponent(workspaceId)}/documents`,
    { token },
  );
  return response.documents;
}

export async function createDocument(
  token: string,
  workspaceId: string,
  title: string,
): Promise<DocumentDto> {
  const response = await request<{ document: DocumentDto }>(
    `/v1/workspaces/${encodeURIComponent(workspaceId)}/documents`,
    { method: "POST", token, body: { title } },
  );
  return response.document;
}

export async function getDocument(token: string, documentId: string): Promise<DocumentDto> {
  const response = await request<{ document: DocumentDto }>(
    `/v1/documents/${encodeURIComponent(documentId)}`,
    { token },
  );
  return response.document;
}

// ---------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------

export async function listComments(
  documentId: string,
  token: string,
): Promise<CommentDto[]> {
  const response = await request<{ comments: CommentDto[] }>(
    `/v1/documents/${encodeURIComponent(documentId)}/comments`,
    { token },
  );
  return response.comments;
}

export async function createCommentRequest(
  documentId: string,
  token: string,
  input: { x: number; y: number; content: string; parentCommentId?: string },
): Promise<CommentDto> {
  const response = await request<{ comment: CommentDto }>(
    `/v1/documents/${encodeURIComponent(documentId)}/comments`,
    { method: "POST", token, body: input },
  );
  return response.comment;
}

export async function resolveComment(
  commentId: string,
  token: string,
  resolved: boolean,
): Promise<CommentDto> {
  const response = await request<{ comment: CommentDto }>(
    `/v1/comments/${encodeURIComponent(commentId)}/resolve`,
    { method: "PATCH", token, body: { resolved } },
  );
  return response.comment;
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

export async function listTemplates(token: string): Promise<TemplateDto[]> {
  const response = await request<{ templates: TemplateDto[] }>("/v1/templates", { token });
  return response.templates;
}

export async function createDocumentFromTemplate(
  token: string,
  workspaceId: string,
  templateId: TemplateId,
  title?: string,
): Promise<DocumentDto> {
  const response = await request<{ document: DocumentDto }>(
    `/v1/workspaces/${encodeURIComponent(workspaceId)}/documents/from-template`,
    { method: "POST", token, body: { templateId, ...(title ? { title } : {}) } },
  );
  return response.document;
}

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

export async function listAssets(token: string, workspaceId: string): Promise<AssetDto[]> {
  const response = await request<{ assets: AssetDto[] }>(
    `/v1/workspaces/${encodeURIComponent(workspaceId)}/assets?limit=100`,
    { token },
  );
  return response.assets;
}

export async function uploadAsset(
  token: string,
  workspaceId: string,
  file: File,
): Promise<AssetDto> {
  if (!(ASSET_MIME_TYPES as readonly string[]).includes(file.type)) {
    throw new ApiRequestError(415, "unsupported_media_type", "Choose a PNG, JPEG, SVG, or WebP image.");
  }
  if (file.size === 0 || file.size > ASSET_MAX_BYTES) {
    throw new ApiRequestError(413, "asset_size", "Images must be smaller than 25 MiB.");
  }

  const { intent } = await request<{ intent: AssetUploadIntentDto }>(
    `/v1/workspaces/${encodeURIComponent(workspaceId)}/assets/upload-intent`,
    {
      method: "POST",
      token,
      body: { fileName: file.name, mimeType: file.type, byteSize: file.size },
    },
  );

  const uploadUrl = new URL(intent.uploadUrl, API_URL);
  if (uploadUrl.origin !== new URL(API_URL).origin) {
    throw new ApiRequestError(502, "invalid_upload_target", "The API returned an unsafe upload target.");
  }

  let uploaded: Response;
  try {
    uploaded = await fetch(uploadUrl, {
      method: intent.method,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": file.type,
      },
      body: file,
      cache: "no-store",
    });
  } catch {
    throw new ApiRequestError(0, "upload_failed", "The image could not be uploaded. Check your connection and try again.");
  }
  if (!uploaded.ok) throw await responseError(uploaded);

  const { asset } = await request<{ asset: AssetDto }>(
    `/v1/workspaces/${encodeURIComponent(workspaceId)}/assets/confirm`,
    {
      method: "POST",
      token,
      body: { assetId: intent.assetId },
    },
  );
  return asset;
}

export function getAssetContentUrl(assetId: string): string {
  return `${API_URL}/v1/assets/${encodeURIComponent(assetId)}/content`;
}

export async function loadAssetPreview(token: string, assetId: string): Promise<string> {
  let response: Response;
  try {
    response = await fetch(getAssetContentUrl(assetId), {
      headers: { authorization: `Bearer ${token}` },
      cache: "force-cache",
    });
  } catch {
    throw new ApiRequestError(0, "network_error", "Cannot load this image. Check your connection.");
  }
  if (!response.ok) throw await responseError(response);
  return URL.createObjectURL(await response.blob());
}

async function responseError(response: Response): Promise<ApiRequestError> {
  const contentType = response.headers.get("content-type") ?? "";
  const payload = contentType.includes("application/json")
    ? ((await response.json().catch(() => null)) as ApiErrorBody | null)
    : null;
  return new ApiRequestError(
    response.status,
    payload?.error?.code ?? "request_failed",
    payload?.error?.message ?? `Request failed with status ${response.status}`,
  );
}
