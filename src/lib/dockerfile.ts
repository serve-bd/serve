/** The base image of a Dockerfile's final stage (`FROM node:22 AS app` → node:22), or null. */
export function dockerfileBase(content: string): string | null {
  const froms = content
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /^from\s/i.test(l));
  const last = froms.at(-1);
  if (!last) return null;
  const image = last
    .split(/\s+/)
    .slice(1)
    .find((part) => !part.startsWith("--"));
  return image ?? null;
}
