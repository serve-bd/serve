import { PERMISSIONS, type Permission } from "./permissions";

/*
 * What an API token may do: a list of the same permissions roles are made of, plus "admin" for
 * what only organization admins (and, for a Root admin, instance admins) may do. A token never
 * does more than its owner's role allows at the moment it is used.
 *
 * Tokens made before fine-grained permissions carry one of the old scopes (read, read:sensitive,
 * deploy, write, admin); they keep doing exactly what they did.
 */

export type TokenGrant = Permission | "admin";
export const TOKEN_GRANTS: readonly TokenGrant[] = [...PERMISSIONS, "admin"];

export const ADMIN_GRANT_INFO = {
  label: "Admin",
  description: "Everything an organization admin may do: members, roles, settings, and for a Root admin the instance itself. Includes every permission.",
};

const READ: Permission[] = ["projects.view", "logs.view"];

/** The old coarse scopes, as permissions. */
export const LEGACY_SCOPES: Record<string, TokenGrant[]> = {
  read: READ,
  "read:sensitive": [...READ, "variables.view-secrets"],
  deploy: [...READ, "services.deploy"],
  write: [...READ, "services.deploy", "services.manage", "variables.edit", "domains.manage"],
  admin: ["admin"],
};

export const isTokenGrant = (value: string): value is TokenGrant => (TOKEN_GRANTS as readonly string[]).includes(value);

/** Permissions and the admin flag a token's stored grants give (before the owner's role limits them). */
export function tokenGrants(stored: readonly string[]): { permissions: Set<Permission>; admin: boolean } {
  const permissions = new Set<Permission>();
  let admin = false;
  for (const s of stored) {
    for (const g of LEGACY_SCOPES[s] ?? (isTokenGrant(s) ? [s] : [])) {
      if (g === "admin") admin = true;
      else permissions.add(g);
    }
  }
  if (admin) for (const p of PERMISSIONS) permissions.add(p);
  return { permissions, admin };
}

/** What someone with these permissions may put on a token. */
export function allowedGrants(permissions: ReadonlySet<Permission>, isAdmin: boolean): Set<TokenGrant> {
  const out = new Set<TokenGrant>(permissions);
  if (isAdmin) out.add("admin");
  return out;
}

/** Valid grants in canonical order; "admin" alone stands for everything. */
export function normalizeGrants(input: readonly string[]): TokenGrant[] {
  const { permissions, admin } = tokenGrants(input);
  if (admin) return ["admin"];
  return PERMISSIONS.filter((p) => permissions.has(p));
}

/** Quick picks in the token dialog. */
export const TOKEN_PRESETS: { id: string; label: string; grants: TokenGrant[] }[] = [
  { id: "read", label: "Read only", grants: ["projects.view", "logs.view"] },
  { id: "deploy", label: "Deploy", grants: ["projects.view", "logs.view", "services.deploy"] },
  { id: "manage", label: "Manage services", grants: ["projects.view", "logs.view", "services.deploy", "services.manage", "variables.edit", "domains.manage"] },
  { id: "admin", label: "Admin", grants: ["admin"] },
];

export const EXPIRY_OPTIONS = [
  { value: "7", label: "7 days" },
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
  { value: "365", label: "1 year" },
  { value: "never", label: "Never" },
] as const;
