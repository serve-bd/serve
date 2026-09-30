import { and, eq } from "drizzle-orm";
import { db, schema } from "@/server/db";
import { BUILTIN_PERMISSIONS, BUILTIN_ROLE_INFO, type BuiltinRole, effectiveRoleId, isBuiltinRole, normalizePermissions, type Permission } from "@/lib/permissions";

export type RoleOption = { id: string; name: string; description: string | null; builtin: BuiltinRole | null; permissions: Permission[] };

export type MemberAccess = {
  roleId: string;
  roleName: string;
  permissions: Set<Permission>;
  /** Null means every project. */
  projectIds: string[] | null;
};

/** Every role an organization can hand out: the four built-in ones (with its Developer override) and its custom roles. */
export async function organizationRoles(organizationId: string): Promise<RoleOption[]> {
  const rows = await db.select().from(schema.orgRole).where(eq(schema.orgRole.organizationId, organizationId));
  const builtins: RoleOption[] = (["owner", "admin", "developer", "viewer"] as const).map((key) => {
    const override = rows.find((r) => r.builtin === key);
    return {
      id: key,
      name: BUILTIN_ROLE_INFO[key].name,
      description: BUILTIN_ROLE_INFO[key].description,
      builtin: key,
      permissions: override && BUILTIN_ROLE_INFO[key].editable ? normalizePermissions(override.permissions) : [...BUILTIN_PERMISSIONS[key]],
    };
  });
  const custom = rows
    .filter((r) => !r.builtin)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((r) => ({ id: r.id, name: r.name, description: r.description, builtin: null, permissions: normalizePermissions(r.permissions) }));
  return [...builtins, ...custom];
}

/**
 * Permissions and project reach of one membership. An unknown custom role gets the default Viewer
 * permissions, not the organization's adjusted Viewer role, which may grant more.
 */
export function accessFrom(member: { role: string; roleId: string | null; projectIds: string[] | null }, roles: RoleOption[]): MemberAccess {
  const roleId = effectiveRoleId(member.role, member.roleId);
  const role = roles.find((r) => r.id === roleId) ?? { id: "viewer", name: BUILTIN_ROLE_INFO.viewer.name, permissions: [...BUILTIN_PERMISSIONS.viewer] };
  const unlimited = role.id === "owner" || role.id === "admin";
  return {
    roleId: role.id,
    roleName: role.name,
    permissions: new Set(role.permissions),
    projectIds: unlimited || !member.projectIds?.length ? null : member.projectIds,
  };
}

export async function memberAccess(organizationId: string, userId: string): Promise<MemberAccess | null> {
  const [member] = await db
    .select({ role: schema.member.role, roleId: schema.member.roleId, projectIds: schema.member.projectIds })
    .from(schema.member)
    .where(and(eq(schema.member.organizationId, organizationId), eq(schema.member.userId, userId)));
  if (!member) return null;
  return accessFrom(member, await organizationRoles(organizationId));
}

export { isBuiltinRole };
