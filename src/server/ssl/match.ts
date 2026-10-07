/** True when one of the certificate names (exact or `*.` wildcard) covers the hostname. */
export function certificateCovers(names: string[], hostname: string): boolean {
  const host = hostname.toLowerCase();
  return names.some((raw) => {
    const name = raw.toLowerCase();
    if (name === host) return true;
    if (name.startsWith("*.")) {
      const base = name.slice(2);
      const rest = host.slice(0, -(base.length + 1));
      return host.endsWith(`.${base}`) && rest.length > 0 && !rest.includes(".");
    }
    return false;
  });
}

/**
 * The certificate to serve a hostname with, of those given: an active one that covers it, its own
 * name before a wildcard, then the one valid longest. Undefined when none covers it.
 */
export function bestCertificate<T extends { domains: string[]; status: string; expiresAt: Date | string | null }>(hostname: string, certs: T[]): T | undefined {
  const host = hostname.toLowerCase();
  const exact = (c: T) => (c.domains.some((d) => d.toLowerCase() === host) ? 1 : 0);
  const until = (c: T) => (c.expiresAt ? new Date(c.expiresAt).getTime() : 0);
  return certs.filter((c) => c.status === "active" && certificateCovers(c.domains, host)).sort((a, b) => exact(b) - exact(a) || until(b) - until(a))[0];
}
