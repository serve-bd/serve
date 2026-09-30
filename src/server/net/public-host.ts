import dns from "node:dns/promises";
import net from "node:net";
import { isPrivateAddress } from "@/server/net/public-fetch";

/** True when a URL's host is (or resolves to) a loopback, private, link-local or reserved address; also when it does not resolve. */
export async function hostIsPrivate(raw: string) {
  const host = new URL(raw.includes("://") ? raw : `https://${raw}`).hostname.replace(/^\[|\]$/g, "");
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true }).catch(() => []);
  return !addrs.length || addrs.some((a) => isPrivateAddress(a.address));
}

/** The host's address when every address it resolves to is public; null otherwise. Connect to it to rule out DNS changes in between. */
export async function publicAddress(host: string) {
  const bare = host.replace(/^\[|\]$/g, "");
  const addrs = net.isIP(bare) ? [{ address: bare }] : await dns.lookup(bare, { all: true }).catch(() => []);
  if (!addrs.length || addrs.some((a) => isPrivateAddress(a.address))) return null;
  return addrs[0]!.address;
}
