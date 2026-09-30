import dns from "node:dns/promises";
import net from "node:net";
import { isPrivateAddress } from "@/server/net/public-fetch";

/** True when a URL's host is (or resolves to) a loopback, private, link-local or reserved address; also when it does not resolve. */
export async function hostIsPrivate(raw: string) {
  const host = new URL(raw.includes("://") ? raw : `https://${raw}`).hostname.replace(/^\[|\]$/g, "");
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true }).catch(() => []);
  return !addrs.length || addrs.some((a) => isPrivateAddress(a.address));
}
