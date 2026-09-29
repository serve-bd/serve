/** Permissions an API token can carry. Higher scopes include lower ones. */
export const API_SCOPES = ["read", "read:sensitive", "deploy", "write", "admin"] as const;
export type ApiScope = (typeof API_SCOPES)[number];

export const SCOPE_INFO: Record<ApiScope, { label: string; description: string }> = {
  read: { label: "Read", description: "List services and deployments, read status and logs. No secrets." },
  "read:sensitive": { label: "Read sensitive data", description: "Also read environment variable values and connection strings." },
  deploy: { label: "Deploy", description: "Trigger deployments and start, stop or restart services." },
  write: { label: "Write", description: "Change services and variables. Includes Read and Deploy." },
  admin: { label: "Admin", description: "Full access to everything the organization can do." },
};

const IMPLIES: Record<ApiScope, ApiScope[]> = {
  read: [],
  "read:sensitive": ["read"],
  deploy: ["read"],
  write: ["read", "deploy"],
  admin: ["read", "read:sensitive", "deploy", "write"],
};

export function isApiScope(value: string): value is ApiScope {
  return (API_SCOPES as readonly string[]).includes(value);
}

/** Every scope a token effectively has, including implied ones. */
export function expandScopes(scopes: readonly string[]): Set<ApiScope> {
  const out = new Set<ApiScope>();
  for (const s of scopes) {
    if (!isApiScope(s)) continue;
    out.add(s);
    for (const implied of IMPLIES[s]) out.add(implied);
  }
  return out;
}

export function hasScope(granted: readonly string[], needed: ApiScope) {
  return expandScopes(granted).has(needed);
}

/** Scopes implied by another selected scope (shown checked and locked in the UI). */
export function impliedScopes(selected: readonly string[]): Set<ApiScope> {
  const out = new Set<ApiScope>();
  for (const s of selected) if (isApiScope(s)) for (const implied of IMPLIES[s]) out.add(implied);
  return out;
}

/** Smallest set of scopes with the same effect, in canonical order. */
export function normalizeScopes(scopes: readonly string[]): ApiScope[] {
  const valid = scopes.filter(isApiScope);
  const implied = impliedScopes(valid);
  return API_SCOPES.filter((s) => valid.includes(s) && !implied.has(s));
}

export const EXPIRY_OPTIONS = [
  { value: "7", label: "7 days" },
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
  { value: "365", label: "1 year" },
  { value: "never", label: "Never" },
] as const;
