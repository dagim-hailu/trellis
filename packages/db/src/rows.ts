import type { MembershipRole } from "@trellis/shared";

export interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  display_name: string;
  created_at: Date;
  updated_at: Date;
}

export interface UserRecord {
  id: string;
  email: string;
  displayName: string;
  passwordHash: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceRow {
  id: string;
  name: string;
  slug: string;
  created_at: Date;
  role: MembershipRole;
}

export interface WorkspaceRecord {
  id: string;
  name: string;
  slug: string;
  role: MembershipRole;
  createdAt: string;
}

export interface DocumentRow {
  id: string;
  workspace_id: string;
  title: string;
  role: MembershipRole;
  created_at: Date;
  updated_at: Date;
}

export interface DocumentRecord {
  id: string;
  workspaceId: string;
  title: string;
  role: MembershipRole;
  createdAt: string;
  updatedAt: string;
}

export interface InvitationRow {
  id: string;
  workspace_id: string;
  email: string;
  role: Exclude<MembershipRole, "owner">;
  expires_at: Date;
  accepted_at: Date | null;
  revoked_at: Date | null;
  created_at: Date;
}

export interface InvitationRecord {
  id: string;
  workspaceId: string;
  email: string;
  role: Exclude<MembershipRole, "owner">;
  expiresAt: string;
  acceptedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export function toUserRecord(row: UserRow): UserRecord {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    passwordHash: row.password_hash,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export function toWorkspaceRecord(row: WorkspaceRow): WorkspaceRecord {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    role: row.role,
    createdAt: row.created_at.toISOString(),
  };
}

export function toDocumentRecord(row: DocumentRow): DocumentRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    title: row.title,
    role: row.role,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export function toInvitationRecord(row: InvitationRow): InvitationRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    email: row.email,
    role: row.role,
    expiresAt: row.expires_at.toISOString(),
    acceptedAt: row.accepted_at?.toISOString() ?? null,
    revokedAt: row.revoked_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

export interface AssetRow {
  id: string;
  workspace_id: string;
  created_by: string;
  mime_type: string;
  byte_size: string;
  storage_key: string;
  public_url: string;
  width: number | null;
  height: number | null;
  created_at: Date;
}

export interface AssetRecord {
  id: string;
  workspaceId: string;
  createdBy: string;
  mimeType: string;
  byteSize: number;
  storageKey: string;
  publicUrl: string;
  width: number | null;
  height: number | null;
  createdAt: string;
}

export function toAssetRecord(row: AssetRow): AssetRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    createdBy: row.created_by,
    mimeType: row.mime_type,
    // bigint arrives as a string from pg; byte sizes are far below 2^53.
    byteSize: Number(row.byte_size),
    storageKey: row.storage_key,
    publicUrl: row.public_url,
    width: row.width,
    height: row.height,
    createdAt: row.created_at.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------

export interface CommentRow {
  id: string;
  document_id: string;
  author_id: string;
  author_name: string;
  parent_comment_id: string | null;
  x: number;
  y: number;
  content: string;
  resolved: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface CommentRecord {
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

export function toCommentRecord(row: CommentRow): CommentRecord {
  return {
    id: row.id,
    documentId: row.document_id,
    authorId: row.author_id,
    authorName: row.author_name,
    parentCommentId: row.parent_comment_id,
    // double precision arrives as a number from pg.
    x: Number(row.x),
    y: Number(row.y),
    content: row.content,
    resolved: row.resolved,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}
