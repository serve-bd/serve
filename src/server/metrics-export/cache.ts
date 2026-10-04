/**
 * Values kept for a few seconds by key, loaded once however many callers ask at the same time.
 * A failed load is not kept: the next caller tries again.
 */
export function ttlCache<T>(ttlMs: number, now: () => number = Date.now) {
  const entries = new Map<string, { at: number; value: Promise<T> }>();
  return {
    get(key: string, load: () => Promise<T>): Promise<T> {
      const t = now();
      const hit = entries.get(key);
      if (hit && t - hit.at < ttlMs) return hit.value;
      // Drop expired keys now and then, so tokens that stopped scraping do not pile up.
      if (entries.size > 100) for (const [k, e] of entries) if (t - e.at >= ttlMs) entries.delete(k);
      const value = load();
      const entry = { at: t, value };
      entries.set(key, entry);
      value.catch(() => {
        if (entries.get(key) === entry) entries.delete(key);
      });
      return value;
    },
    clear() {
      entries.clear();
    },
    get size() {
      return entries.size;
    },
  };
}

/**
 * Keeps the last good value per key and refreshes it in the background once it is older than
 * `freshMs`: callers get an answer at once (only the first one waits). A value older than
 * `maxAgeMs` is no longer handed out while a refresh fails.
 */
export function staleWhileRevalidate<T>(freshMs: number, maxAgeMs: number, now: () => number = Date.now) {
  const entries = new Map<string, { at: number; value: T }>();
  const loading = new Map<string, Promise<T | null>>();
  return {
    async get(key: string, load: () => Promise<T>): Promise<T | null> {
      const t = now();
      const hit = entries.get(key);
      if (hit && t - hit.at < freshMs) return hit.value;
      let run = loading.get(key);
      if (!run) {
        run = load()
          .then((value) => {
            entries.set(key, { at: now(), value });
            return value;
          })
          .catch(() => null)
          .finally(() => loading.delete(key));
        loading.set(key, run);
      }
      if (hit && t - hit.at < maxAgeMs) return hit.value;
      const fresh = await run;
      if (fresh !== null) return fresh;
      const last = entries.get(key);
      return last && now() - last.at < maxAgeMs ? last.value : null;
    },
    clear() {
      entries.clear();
      loading.clear();
    },
  };
}

export type ExportScope = {
  organizationId: string;
  /** Null means every project of the organization. */
  projectIds: string[] | null;
  /** Request rates come from the access log: only for tokens that may read logs, like the dashboard. */
  requests: boolean;
  /** Host figures of the servers: Root admins only. */
  hosts: boolean;
};

export function cacheKey(scope: ExportScope) {
  return [scope.organizationId, scope.projectIds ? [...scope.projectIds].sort().join(",") : "*", scope.requests ? "r" : "", scope.hosts ? "h" : ""].join("|");
}
