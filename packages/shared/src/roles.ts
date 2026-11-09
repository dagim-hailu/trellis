export const MEMBERSHIP_ROLES = ["owner", "editor", "viewer"] as const;

export type MembershipRole = (typeof MEMBERSHIP_ROLES)[number];

const ROLE_RANK: Readonly<Record<MembershipRole, number>> = {
  viewer: 10,
  editor: 20,
  owner: 30,
};

export function roleAtLeast(actual: MembershipRole, required: MembershipRole): boolean {
  return ROLE_RANK[actual] >= ROLE_RANK[required];
}

export function canEdit(role: MembershipRole): boolean {
  return roleAtLeast(role, "editor");
}

export function isMembershipRole(value: unknown): value is MembershipRole {
  return typeof value === "string" && (MEMBERSHIP_ROLES as readonly string[]).includes(value);
}
