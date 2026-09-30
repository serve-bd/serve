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
