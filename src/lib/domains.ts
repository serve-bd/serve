/**
 * The domain that represents a service (SERVE_PUBLIC_URL, links in the UI):
 * the one marked primary, else the oldest custom domain, else the oldest
 * generated one. Redirect domains never count.
 */
export function pickPrimaryDomain<T extends { redirectTo: string | null; generated: boolean; primary?: boolean; createdAt?: Date | string }>(domains: T[]): T | null {
  const time = (d: T) => (d.createdAt ? new Date(d.createdAt).getTime() : 0);
  return (
    domains.filter((d) => !d.redirectTo).sort((a, b) => Number(!!b.primary) - Number(!!a.primary) || Number(a.generated) - Number(b.generated) || time(a) - time(b))[0] ?? null
  );
}
