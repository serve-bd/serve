/**
 * Requests per minute per API token, counted in this process: a fixed one-minute window, like
 * most APIs, with the standard X-RateLimit headers.
 */
const windows = new Map<string, { start: number; count: number }>();
const WINDOW_MS = 60_000;

/**
 * Scrapes of GET /api/v1/metrics per minute per token, on top of the general limit: enough for
 * several Prometheus servers scraping every 15 seconds with one token, while a loop that asks
 * nonstop is held back (the answer is cached for a few seconds anyway).
 */
export const METRICS_RATE_LIMIT = 60;

export type RateResult = { allowed: boolean; headers: Record<string, string> };

/** Keys kept at most: a forged flood then only costs memory up to this. */
const MAX_KEYS = 200_000;
let lastSweep = 0;

export function takeRequest(key: string, limit: number, now = Date.now()): RateResult {
  if (limit <= 0) return { allowed: true, headers: {} };
  let w = windows.get(key);
  if (!w || now - w.start >= WINDOW_MS) {
    w = { start: now, count: 0 };
    windows.set(key, w);
    // Windows that went quiet are dropped at most once a window, so a flood of new keys (forged
    // client addresses) costs one pass a minute, not one per request. Past a hard cap, the oldest go.
    if (windows.size > 10_000 && now - lastSweep >= WINDOW_MS) {
      lastSweep = now;
      for (const [k, v] of windows) if (now - v.start >= WINDOW_MS) windows.delete(k);
    }
    // Maps keep insertion order: the first keys are the oldest.
    const keys = windows.keys();
    while (windows.size > MAX_KEYS) {
      const oldest = keys.next();
      if (oldest.done) break;
      windows.delete(oldest.value);
    }
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
  lastSweep = 0;
}
