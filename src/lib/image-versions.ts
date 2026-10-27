/** A version tag: optional v, up to four numbers, then a suffix (-alpine, -bookworm). */
const VERSION = /^(v?)(\d+(?:\.\d+){0,3})(-[A-Za-z0-9.-]+)?$/;

function compareVersions(a: string, b: string) {
  const x = a.split(".").map(Number);
  const y = b.split(".").map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
}

/**
 * The highest tag of the same form as `current` above it: as many numbers, the same prefix and
 * suffix (8-alpine → 9-alpine, never 9-rc1-alpine or 9.1-alpine). Null for tags like latest.
 */
export function newerVersionTag(current: string, tags: string[]): string | null {
  const m = VERSION.exec(current);
  if (!m) return null;
  const parts = m[2].split(".").length;
  let best: string | null = null;
  let bestVersion = m[2];
  for (const tag of tags) {
    const t = VERSION.exec(tag);
    if (!t || t[1] !== m[1] || (t[3] ?? "") !== (m[3] ?? "") || t[2].split(".").length !== parts) continue;
    if (compareVersions(t[2], bestVersion) > 0) {
      best = tag;
      bestVersion = t[2];
    }
  }
  return best;
}
