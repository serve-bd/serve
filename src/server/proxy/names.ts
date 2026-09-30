import crypto from "node:crypto";

/** Network alias for a compose service on the shared Serve network. */
export function composeAlias(slug: string, composeService: string) {
  return `${slug}-${composeService}`.toLowerCase().replace(/[^a-z0-9-]/g, "-");
}

const plainUpstreamName = (slug: string, suffix: string) => `svc_${slug}_${suffix}`.replace(/[^a-zA-Z0-9_]/g, "_");

/**
 * nginx upstream names on one server, from every (slug, suffix) its sites use. Upstream names are
 * global to the proxy: a name stays `svc_<slug>_<suffix>` (custom configs may proxy_pass to it),
 * and only one that two different keys share once sanitized (slug "a" + "b_80" vs "a-b" + "80")
 * gets a short hash of its raw parts.
 */
export function upstreamNamer(keys: { slug: string; suffix: string }[]) {
  const byName = new Map<string, Set<string>>();
  for (const k of keys) {
    const name = plainUpstreamName(k.slug, k.suffix);
    byName.set(name, (byName.get(name) ?? new Set()).add(JSON.stringify([k.slug, k.suffix])));
  }
  return (slug: string, suffix: string) => {
    const name = plainUpstreamName(slug, suffix);
    const raw = JSON.stringify([slug, suffix]);
    const others = [...(byName.get(name) ?? [])].filter((k) => k !== raw);
    if (!others.length) return name;
    return `${name}_${crypto.createHash("sha256").update(raw).digest("hex").slice(0, 8)}`;
  };
}

/**
 * Network only the proxy and the cloudflared connectors join. The proxy trusts the visitor IP
 * (CF-Connecting-IP, X-Forwarded-For) from this network alone: services share the main network.
 */
export function tunnelNetworkName(network: string) {
  return `${network}-tunnel`;
}
