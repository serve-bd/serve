/**
 * What a member of an organization may do. Roles are sets of these; the server
 * checks them on every action and route, and the UI hides what a role cannot do.
 */
export const PERMISSIONS = [
  "projects.view",
  "projects.manage",
  "services.deploy",
  "deploys.approve",
  "services.manage",
  "domains.manage",
  "variables.edit",
  "variables.view-secrets",
  "databases.backups",
  "console.access",
  "logs.view",
  "status-pages.manage",
  "members.manage",
  "integrations.manage",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export const PERMISSION_GROUPS: { title: string; permissions: Permission[] }[] = [
  { title: "Projects and services", permissions: ["projects.view", "projects.manage", "services.deploy", "deploys.approve", "services.manage", "domains.manage"] },
  { title: "Variables and data", permissions: ["variables.edit", "variables.view-secrets", "databases.backups"] },
  { title: "Operations", permissions: ["logs.view", "console.access", "status-pages.manage"] },
  { title: "Organization", permissions: ["members.manage", "integrations.manage"] },
];

export const PERMISSION_INFO: Record<Permission, { label: string; description: string; verb: string }> = {
  "projects.view": { label: "View projects", description: "See projects, services, deployments and their status.", verb: "view projects" },
  "projects.manage": { label: "Manage projects", description: "Create, rename and delete projects and environments.", verb: "manage projects" },
  "services.deploy": { label: "Deploy", description: "Deploy, redeploy, roll back, start, stop and restart services.", verb: "deploy services" },
  "deploys.approve": {
    label: "Approve deploys",
    description: "Approve or reject deploys that wait for approval. Their own deploys start right away.",
    verb: "approve deploys",
  },
  "services.manage": { label: "Manage services", description: "Create and delete services and change their settings.", verb: "change services" },
  "domains.manage": { label: "Manage domains", description: "Add, edit and remove domains, ports and proxy options.", verb: "manage domains" },
  "variables.edit": { label: "Edit variables", description: "Add, change and delete environment and shared variables.", verb: "edit variables" },
  "variables.view-secrets": {
    label: "See secret values",
    description: "Reveal and copy secret variables, database passwords and connection URLs.",
    verb: "see secret values",
  },
  "databases.backups": { label: "Database backups", description: "Run, download, restore and import database backups.", verb: "manage backups" },
  "logs.view": { label: "View logs", description: "Read build, runtime and request logs.", verb: "view logs" },
  "status-pages.manage": {
    label: "Status pages",
    description: "Create and change public status pages, and post incidents and maintenance on them.",
    verb: "manage status pages",
  },
  "console.access": { label: "Console", description: "Open a shell inside containers and servers.", verb: "open the console" },
  "members.manage": { label: "Manage members", description: "Invite and remove members, change roles and project access.", verb: "manage members" },
  "integrations.manage": {
    label: "Manage integrations",
    description: "Git providers, Cloudflare, S3 storage, registries, notifications, templates and certificates.",
    verb: "manage integrations",
  },
};

export type BuiltinRole = "owner" | "admin" | "developer" | "viewer";
export const BUILTIN_ROLES: BuiltinRole[] = ["owner", "admin", "developer", "viewer"];

export const BUILTIN_ROLE_INFO: Record<BuiltinRole, { name: string; description: string; editable: boolean }> = {
  owner: { name: "Owner", description: "Everything, including deleting the organization and managing owners.", editable: false },
  admin: { name: "Admin", description: "Everything except managing owners and deleting the organization.", editable: false },
  developer: { name: "Developer", description: "Deploys and changes services. Cannot see secret values unless you allow it.", editable: true },
  viewer: { name: "Viewer", description: "Read-only by default: projects, services, deployments and logs.", editable: true },
};

/** Default permissions of each built-in role. Developer and Viewer can be adjusted per organization. */
export const BUILTIN_PERMISSIONS: Record<BuiltinRole, readonly Permission[]> = {
  owner: PERMISSIONS,
  admin: PERMISSIONS,
  developer: ["projects.view", "services.deploy", "services.manage", "domains.manage", "variables.edit", "databases.backups", "logs.view", "console.access", "status-pages.manage"],
  viewer: ["projects.view", "logs.view"],
};

export function isBuiltinRole(value: string | null | undefined): value is BuiltinRole {
  return !!value && (BUILTIN_ROLES as string[]).includes(value);
}

export function isPermission(value: string): value is Permission {
  return (PERMISSIONS as readonly string[]).includes(value);
}

/** Valid permissions only, in canonical order; "view projects" is always included. */
export function normalizePermissions(values: readonly string[]): Permission[] {
  const set = new Set(values.filter(isPermission));
  set.add("projects.view");
  return PERMISSIONS.filter((p) => set.has(p));
}

/** The better-auth role a member row keeps for a role (it only knows owner, admin and member). */
export function memberRoleFor(roleId: string): "owner" | "admin" | "member" {
  return roleId === "owner" ? "owner" : roleId === "admin" ? "admin" : "member";
}

/** A member's role id: the stored one, else derived from the better-auth role. */
export function effectiveRoleId(memberRole: string, roleId: string | null | undefined): string {
  if (memberRole === "owner") return "owner";
  if (memberRole === "admin") return "admin";
  return roleId && roleId !== "owner" && roleId !== "admin" ? roleId : "developer";
}

/** "Your role cannot …" for tooltips and errors. */
export function cannotMessage(permission: Permission) {
  return `Your role cannot ${PERMISSION_INFO[permission].verb}.`;
}

/**
 * Whether someone may hand out a role: owners any role, admins any but Owner, and others
 * with "manage members" only roles that have no more permissions than their own.
 */
export function canGrant(granter: { roleId: string; permissions: readonly Permission[] }, role: { id: string; permissions: readonly Permission[] }) {
  if (granter.roleId === "owner") return true;
  if (granter.roleId === "admin") return role.id !== "owner";
  return role.id !== "owner" && role.id !== "admin" && role.permissions.every((p) => granter.permissions.includes(p));
}
