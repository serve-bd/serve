/**
 * Name used in ${{name.VAR}} references: lowercase letters, digits and dashes.
 * "Postgresql SD" → "postgresql-sd".
 */
export function referenceName(serviceName: string) {
  return (
    serviceName
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "service"
  );
}

export function referenceOf(serviceName: string, key: string) {
  return `\${{${referenceName(serviceName)}.${key}}}`;
}

/** A reference in a variable value: ${{KEY}} or ${{service.KEY}}. */
export const REF = /\$\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g;

/** Variables that hold private names: they only work on the same server or across a shared private network. */
export const PRIVATE_VARS = /^(HOST|PORT|DATABASE_URL|REDIS_URL|MONGO_URL|POSTGRES_URL|MYSQL_URL|SERVE_PRIVATE_DOMAIN)$/;

/**
 * The sibling service a `${{name.KEY}}` reference points at, matched like variable resolution does:
 * by slug always, by name (as typed or dashed) only when no other service shares it.
 */
export function referencedService<T extends { id: string; name: string; slug: string }>(siblings: T[], name: string): T | undefined {
  const n = name.toLowerCase();
  const bySlug = siblings.find((s) => s.slug.toLowerCase() === n);
  if (bySlug) return bySlug;
  const byName = siblings.filter((s) => s.name.toLowerCase() === n || referenceName(s.name) === n);
  if (byName.length !== 1) return undefined;
  // Two services with the same dashed name answer to neither name.
  return siblings.filter((s) => referenceName(s.name) === referenceName(byName[0].name)).length === 1 ? byName[0] : undefined;
}

/** Services a set of variable values points at: `${{name.KEY}}` → the service and the keys used. */
export function referencesIn(values: string[]): { name: string; key: string }[] {
  const out: { name: string; key: string }[] = [];
  for (const value of values)
    for (const [, ref] of value.matchAll(REF)) {
      const dot = ref.indexOf(".");
      if (dot > 0) out.push({ name: ref.slice(0, dot), key: ref.slice(dot + 1) });
    }
  return out;
}
