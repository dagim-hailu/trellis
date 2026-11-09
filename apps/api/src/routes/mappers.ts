import type { DocumentDto, UserDto, WorkspaceDto } from "@trellis/shared";
import type {
  DocumentRecord,
  UserRecord,
  WorkspaceMemberRecord,
  WorkspaceRecord,
} from "@trellis/db";

export function toUserDto(user: UserRecord): UserDto {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    createdAt: user.createdAt,
  };
}

export function toWorkspaceDto(workspace: WorkspaceRecord): WorkspaceDto {
  return {
    id: workspace.id,
    name: workspace.name,
    slug: workspace.slug,
    role: workspace.role,
    createdAt: workspace.createdAt,
  };
}

export function toDocumentDto(document: DocumentRecord): DocumentDto {
  return {
    id: document.id,
    workspaceId: document.workspaceId,
    title: document.title,
    role: document.role,
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
  };
}

export function toMemberDto(member: WorkspaceMemberRecord): {
  userId: string;
  email: string;
  displayName: string;
  role: WorkspaceMemberRecord["role"];
  joinedAt: string;
} {
  return {
    userId: member.userId,
    email: member.email,
    displayName: member.displayName,
    role: member.role,
    joinedAt: member.joinedAt,
  };
}
