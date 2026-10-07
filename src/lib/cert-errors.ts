/** Turns raw certbot / ACME errors into a short explanation and the next step. */
export function explainCertError(error: string, ctx: { serverIp?: string | null; provider: string }): { title: string; hint: string } {
  // Issued or renewed fine, but a proxy or database did not load it (applyCertificate).
  const notLoaded = error.match(/^Not loaded everywhere yet: ([\s\S]*)$/);
  if (notLoaded)
    return {
      title: "Not loaded everywhere",
      hint: `The certificate is valid, but these could not load it yet: ${notLoaded[1].replace(/\.? The log says why\.$/, "")}. The log says why (often a proxy config error or a server that does not answer); fix it, then retry.`,
    };
  const e = error.toLowerCase();
  const domains = [...new Set([...error.matchAll(/(?:for|looking up (?:a|aaaa|txt|caa) for) ([a-z0-9*._-]+\.[a-z]{2,})/gi)].map((m) => m[1].replace(/^_acme-challenge\./, "")))];
  const which = domains.length ? domains.join(", ") : "the domain";
  const ip = ctx.serverIp ? ` pointing to ${ctx.serverIp}` : " pointing to this server";

  const port = error.match(/listens on port (\d+), but Let's Encrypt only checks port 80/);
  if (port)
    return {
      title: `Let's Encrypt cannot reach port ${port[1]}`,
      hint: `The HTTP check only uses port 80, so it cannot work on this machine. Connect Cloudflare in Integrations to use the DNS check. For local testing, turn off HTTPS on the domain and open http://${domains[0] ?? "your-domain"}:${port[1]}, or add a localhost port in Domains & ports.`,
    };
  const wrong = error.match(/points to ([\d., ]+), not to .+?\(([\d.]+)\)/);
  if (wrong) return { title: `${which} points somewhere else`, hint: `Its A record is ${wrong[1].trim()}. Change it to ${wrong[2]} and retry.` };
  if (/needs the DNS check/.test(error))
    return { title: "Wildcard certificates need the DNS check", hint: "Connect Cloudflare in Integrations, then request the certificate with Cloudflare DNS." };
  // Let's Encrypt reached a Cloudflare edge address: the orange-cloud proxy is on.
  if (
    ctx.provider === "letsencrypt-http" &&
    /2606:4700:|2a06:98c[01]:|\b(104\.(1[6-9]|2[0-7])|172\.(6[4-9]|7[01])|162\.15[89]|188\.114\.9[6-9]|141\.101\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7]))\./.test(e)
  )
    return {
      title: `${which} is behind Cloudflare's proxy`,
      hint: "The HTTP check cannot pass through it here. Connect the Cloudflare account in Integrations and retry: Serve then uses the DNS check automatically.",
    };
  if (/nxdomain|no valid ip addresses found|dns problem: servfail/.test(e))
    return { title: `No DNS record for ${which}`, hint: `Add an A record${ip}, wait for it to propagate, then retry.` };
  if (/rate ?limit|too many (certificates|failed authorizations)/.test(e))
    return { title: "Let's Encrypt rate limit reached", hint: "Too many requests for this domain recently. Wait an hour or more, or turn on staging while testing." };
  if (/timeout during connect|connection refused|connection reset|firewall/.test(e))
    return {
      title: `Let's Encrypt could not reach ${which}`,
      hint: "Open port 80 on this server and its firewall. With Cloudflare proxy on, use the Cloudflare DNS method instead.",
    };
  if (/unauthorized|invalid response|404/.test(e))
    return { title: `The HTTP check failed for ${which}`, hint: `The domain answers, but not from this server. Check that its A record points${ip.replace(" pointing", "")}.` };
  if (/cloudflare account of this certificate was disconnected/.test(e))
    return { title: "No Cloudflare account for this certificate", hint: "Its account was disconnected. Connect a Cloudflare account that manages these domains, then retry." };
  if (/caa record/.test(e)) return { title: "A CAA record blocks Let's Encrypt", hint: "Allow letsencrypt.org in the domain's CAA records, or remove them." };
  if (/incorrect txt record|_acme-challenge/.test(e) || ctx.provider === "letsencrypt-cloudflare") {
    if (/authentication|permission|invalid (api )?token|10000|9109/.test(e))
      return { title: "Cloudflare rejected the API token", hint: "The token needs Zone · DNS · Edit on this zone. Update it in Integrations → Cloudflare." };
    if (/incorrect txt record|_acme-challenge/.test(e))
      return { title: "The DNS challenge record was not found", hint: "Check that the zone is managed by the connected Cloudflare account, then retry." };
  }
  if (/acme email|account email|register/.test(e)) return { title: "Let's Encrypt account is not set up", hint: "Add an account email in Server settings → Let's Encrypt." };
  if (/origin ca|origin certificate/.test(e))
    return { title: "Cloudflare could not issue the origin certificate", hint: "The token needs the SSL and Certificates · Edit permission." };
  return { title: "The certificate could not be issued", hint: "Open the log for the full output, fix the cause, then retry." };
}
