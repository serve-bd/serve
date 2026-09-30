import crypto from "node:crypto";

/** Network alias for a compose service on the shared Serve network. */
export function composeAlias(slug: string, composeService: string) {
  return `${slug}-${composeService}`.toLowerCase().replace(/[^a-z0-9-]/g, "-");
}

/**
 * nginx upstream of a service site. Upstream names are global to the proxy: a short hash of the
 * raw parts keeps names apart that read the same once sanitized (slug "a" + "b_80" vs "a-b" + "80").
 */
export function upstreamName(slug: string, suffix: string) {
  const hash = crypto
    .createHash("sha256")
    .update(JSON.stringify([slug, suffix]))
    .digest("hex")
    .slice(0, 8);
  return `svc_${slug}_${suffix}_${hash}`.replace(/[^a-zA-Z0-9_]/g, "_");
}

/**
 * Network only the proxy and the cloudflared connectors join. The proxy trusts the visitor IP
 * (CF-Connecting-IP, X-Forwarded-For) from this network alone: services share the main network.
 */
export function tunnelNetworkName(network: string) {
  return `${network}-tunnel`;
}
