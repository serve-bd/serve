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

/** Names a Dockerfile ARG can take (variables with other characters are passed but not declared). */
const ARG_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Declares `keys` as ARG in every stage, right after each FROM (a build argument only reaches the
 * stages that declare it). Stages that already declare a key keep their own line, with its default.
 */
export function declareBuildArgs(content: string, keys: string[]): string {
  const names = [...new Set(keys)].filter((k) => ARG_NAME.test(k));
  if (!names.length) return content;
  const lines = content.split(/\r?\n/);
  // Stages: from a FROM line to the next one. Keys each stage declares itself are skipped.
  const fromAt = lines.flatMap((l, i) => (/^\s*from\s/i.test(l) ? [i] : []));
  if (!fromAt.length) return content;
  const out: string[] = [];
  let stage = -1;
  for (let i = 0; i < lines.length; i++) {
    out.push(lines[i]);
    if (!fromAt.includes(i)) continue;
    stage++;
    // A FROM continued with a backslash ends on a later line.
    while (/\\\s*$/.test(out[out.length - 1]) && i + 1 < lines.length) out.push(lines[++i]);
    const end = stage + 1 < fromAt.length ? fromAt[stage + 1] : lines.length;
    const own = new Set(
      lines
        .slice(i + 1, end)
        .map((l) => /^\s*arg\s+([A-Za-z_][A-Za-z0-9_]*)/i.exec(l)?.[1])
        .filter((k): k is string => !!k),
    );
    for (const k of names) if (!own.has(k)) out.push(`ARG ${k}`);
  }
  return out.join("\n");
}
