const attempts = new Map<string, number[]>();

/** Counts an attempt for `key`; true once more than `max` fall within the window. In memory: the dashboard is one process. */
export function tooManyAttempts(key: string, max: number, windowMs: number) {
  const now = Date.now();
  if (attempts.size > 10_000) for (const [k, v] of attempts) if (v.at(-1)! < now - windowMs) attempts.delete(k);
  const recent = (attempts.get(key) ?? []).filter((t) => t > now - windowMs);
  recent.push(now);
  attempts.set(key, recent);
  return recent.length > max;
}
