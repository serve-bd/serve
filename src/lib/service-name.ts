/**
 * Service names: letters, numbers and hyphens only, so `${{name.KEY}}` references read the same
 * everywhere. Spaces and other characters are dropped while typing.
 */
export const SERVICE_NAME_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,58}[A-Za-z0-9])?$/;

/** What an input keeps while the user types. */
export function typedServiceName(value: string) {
  return value.replace(/[^A-Za-z0-9-]/g, "").slice(0, 60);
}

/** A valid name from any text, like a template title: "Uptime Kuma" → "Uptime-Kuma". */
export function toServiceName(value: string, fallback = "service") {
  const name = value
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^A-Za-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
  return name || fallback;
}
