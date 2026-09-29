/** The name other services use to reach this one on the private network. */
export function privateHost(service: { slug: string; hostname?: string | null }) {
  return service.hostname || service.slug;
}

/** Network aliases for a service's containers: always the slug, plus the chosen hostname. */
export function networkAliases(service: { slug: string; hostname?: string | null }) {
  return service.hostname && service.hostname !== service.slug ? [service.slug, service.hostname] : [service.slug];
}

export const HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
