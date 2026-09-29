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
