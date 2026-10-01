import { AsyncLocalStorage } from "node:async_hooks";
import type { Permission } from "@/lib/permissions";

/**
 * The API token a request runs as. While it is set, requireOrg() and the other session helpers
 * answer for the token instead of a browser session, so every dashboard action runs with the
 * token's permissions and project limits: the API does what the dashboard does, checked the same way.
 */
export type ApiPrincipal = {
  tokenId: string;
  userId: string;
  organizationId: string;
  /** The token's permissions that its owner's role still has. */
  permissions: Set<Permission>;
  /** Organization admin powers: the token has "admin" and its owner is an owner or admin. */
  admin: boolean;
  /** Null means every project. */
  projectIds: string[] | null;
};

const store = new AsyncLocalStorage<ApiPrincipal>();

export const apiPrincipal = () => store.getStore() ?? null;

export function runAsToken<T>(principal: ApiPrincipal, fn: () => Promise<T>) {
  return store.run(principal, fn);
}
