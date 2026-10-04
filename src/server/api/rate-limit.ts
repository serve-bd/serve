/**
 * Requests per minute per API token, counted in this process: a fixed one-minute window, like
 * most APIs, with the standard X-RateLimit headers.
 */
const windows = new Map<string, { start: number; count: number }>();
const WINDOW_MS = 60_000;

export type RateResult = { allowed: boolean; headers: Record<string, string> };

export function takeRequest(key: string, limit: number, now = Date.now()): RateResult {
  if (limit <= 0) return { allowed: true, headers: {} };
  let w = windows.get(key);
  if (!w || now - w.start >= WINDOW_MS) {
    w = { start: now, count: 0 };
    windows.set(key, w);
    // Windows of tokens that went quiet are dropped now and then, so the map stays small.
    if (windows.size > 10_000) for (const [k, v] of windows) if (now - v.start >= WINDOW_MS) windows.delete(k);
  }
  const reset = Math.ceil((w.start + WINDOW_MS) / 1000);
  const allowed = w.count < limit;
  if (allowed) w.count += 1;
  const headers: Record<string, string> = {
    "x-ratelimit-limit": String(limit),
    "x-ratelimit-remaining": String(Math.max(0, limit - w.count)),
    "x-ratelimit-reset": String(reset),
  };
  if (!allowed) headers["retry-after"] = String(Math.max(1, Math.ceil((w.start + WINDOW_MS - now) / 1000)));
  return { allowed, headers };
}

/** For tests. */
export function resetRateLimits() {
  windows.clear();
}
