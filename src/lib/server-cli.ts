/* The decisions behind cli.json (see src/server/server-cli.ts), kept pure for tests. */

type TokenRow = { id: string; userId: string; expiresAt: Date | null };

/**
 * The token cli.json may keep, and the one to revoke once it is replaced. Tokens are known by id
 * (stored in settings), never by name: a token someone named "Server CLI" is theirs.
 * `fileToken`: the row the file's token matches. Before an id was stored, that token is adopted.
 */
export function serverCliTokens(storedId: string | null, stored: TokenRow | null, fileToken: TokenRow | null): { current: TokenRow | null; retire: string | null } {
  if (!storedId) return { current: fileToken, retire: null };
  const current = fileToken && fileToken.id === storedId ? fileToken : null;
  return { current, retire: !current && stored ? stored.id : null };
}

export type ServerCliPlan = { action: "keep"; tokenId: string } | { action: "create"; userId: string } | { action: "none" };

/**
 * Keep the file's token while it still works for a Root admin, else make one for the oldest admin.
 * `current`: the token row the file's token matches in the Root organization, if any.
 * `admins`: user ids of the Root organization's owners and admins, oldest member first.
 */
export function serverCliPlan(current: { id: string; userId: string; expiresAt: Date | null } | null, admins: string[], now = Date.now()): ServerCliPlan {
  if (current && (!current.expiresAt || current.expiresAt.getTime() > now) && admins.includes(current.userId)) return { action: "keep", tokenId: current.id };
  return admins.length ? { action: "create", userId: admins[0] } : { action: "none" };
}

/**
 * The address the CLI on this host reaches the dashboard at. In the container setup the dashboard
 * port is published on the host (SERVE_DASHBOARD_PORT); 127.0.0.1 inside the container would be
 * the container itself. Without a container (development) it is the local app URL.
 */
export function hostDashboardUrl(vars: Record<string, string | undefined>, publicUrl: string | null) {
  const published = vars.SERVE_DASHBOARD_PORT?.trim();
  if (published && /^\d+$/.test(published)) return `http://127.0.0.1:${published}`;
  if (!vars.SERVE_ROLE) {
    const app = vars.BETTER_AUTH_URL?.replace(/\/$/, "");
    if (app && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(app)) return app;
    return `http://localhost:${vars.PORT || 3000}`;
  }
  return publicUrl ?? `http://127.0.0.1:${vars.PORT || 3000}`;
}
