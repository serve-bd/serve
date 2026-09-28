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
