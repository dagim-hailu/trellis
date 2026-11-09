import { z } from "zod";

import { MEMBERSHIP_ROLES, type MembershipRole } from "./roles.js";

export const documentIdSchema = z.string().uuid();
export const emailSchema = z.string().trim().toLowerCase().email().max(254);
export const passwordSchema = z.string().min(12).max(128);
export const displayNameSchema = z.string().trim().min(2).max(80);

export const registerSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  displayName: displayNameSchema,
});

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(128),
});

export const createWorkspaceSchema = z.object({
  name: z.string().trim().min(1).max(80),
});

export const createDocumentSchema = z.object({
  title: z.string().trim().min(1).max(160).default("Untitled canvas"),
});

export const renameDocumentSchema = z.object({
  title: z.string().trim().min(1).max(160),
});

export const invitationRoleSchema = z.enum(["editor", "viewer"]);

export const createInvitationSchema = z.object({
  email: emailSchema,
  role: invitationRoleSchema,
  expiresInHours: z.number().int().min(1).max(168).default(72),
});

export const acceptInvitationSchema = z.object({
  token: z.string().min(32).max(256),
});

export interface UserDto {
  id: string;
  email: string;
  displayName: string;
  createdAt: string;
}

export interface AuthResponseDto {
  accessToken: string;
  expiresIn: number;
  user: UserDto;
}

export interface WorkspaceDto {
  id: string;
  name: string;
  slug: string;
  role: MembershipRole;
  createdAt: string;
}

export interface DocumentDto {
  id: string;
  workspaceId: string;
  title: string;
  role: MembershipRole;
  createdAt: string;
  updatedAt: string;
}

export interface InvitationDto {
  id: string;
  workspaceId: string;
  email: string;
  role: Exclude<MembershipRole, "owner">;
  expiresAt: string;
  createdAt: string;
  /** Present exactly once, in the invitation-creation response. */
  token?: string;
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    requestId?: string;
  };
}

export const membershipRoleSchema = z.enum(MEMBERSHIP_ROLES);

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

export const ASSET_MAX_BYTES = 26_214_400; // 25 MiB

export const ASSET_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/svg+xml",
  "image/webp",
] as const;
export type AssetMimeType = (typeof ASSET_MIME_TYPES)[number];

export const assetMimeTypeSchema = z.enum(ASSET_MIME_TYPES);

export const assetUploadIntentSchema = z.object({
  fileName: z.string().trim().min(1).max(255),
  mimeType: assetMimeTypeSchema,
  byteSize: z
    .number()
    .int()
    .min(1)
    .max(ASSET_MAX_BYTES, `Assets are limited to ${ASSET_MAX_BYTES} bytes`),
  width: z.number().int().positive().max(20_000).optional(),
  height: z.number().int().positive().max(20_000).optional(),
});

export const assetConfirmSchema = z.object({
  assetId: z.string().uuid(),
  width: z.number().int().positive().max(20_000).optional(),
  height: z.number().int().positive().max(20_000).optional(),
});

export interface AssetDto {
  id: string;
  workspaceId: string;
  mimeType: AssetMimeType;
  byteSize: number;
  publicUrl: string;
  width: number | null;
  height: number | null;
  createdBy: string;
  createdAt: string;
}

export interface AssetUploadIntentDto {
  assetId: string;
  uploadUrl: string;
  publicUrl: string;
  /** HTTP method the client must use against uploadUrl. */
  method: "PUT";
  /** Headers the client must send with the upload. */
  headers: Record<string, string>;
  expiresAt: string;
}

// ---------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------

export const COMMENT_MAX_LENGTH = 4000;

export const createCommentSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  content: z.string().trim().min(1).max(COMMENT_MAX_LENGTH),
  parentCommentId: z.string().uuid().optional(),
});

export const resolveCommentSchema = z.object({
  resolved: z.boolean(),
});

export interface CommentDto {
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
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

export const TEMPLATE_IDS = [
  "mind-map",
  "kanban",
  "brainstorm-grid",
  "retro-board",
  "flowchart",
] as const;
export type TemplateId = (typeof TEMPLATE_IDS)[number];

export const templateIdSchema = z.enum(TEMPLATE_IDS);

export const instantiateTemplateSchema = z.object({
  templateId: templateIdSchema,
  title: z.string().trim().min(1).max(160).optional(),
});

export interface TemplateDto {
  id: TemplateId;
  name: string;
  description: string;
  /** Approximate node count, so the UI can show a size hint. */
  nodeCount: number;
}

export interface TemplateInstantiationDto {
  document: DocumentDto;
}
