"use client";

import * as React from "react";
import { ArrowUpRight, Cloud, Globe, Lock, LockOpen, MoreHorizontal, Pencil, Plus, RefreshCw, Sparkles, Star, Trash2, CornerDownRight, Waypoints } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardHeader, CopyButton, EmptyState } from "@/components/ui/misc";
import { Dialog, DialogBody, DialogClose, DialogContent, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { SwitchRow } from "@/components/ui/switch";
import { Led } from "@/components/ui/status";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { Tooltip } from "@/components/ui/tooltip";
import { useConfirm } from "@/components/ui/confirm";
import { toast } from "@/components/ui/toast";
import { useAction } from "@/hooks/use-action";
import {
  addDomain,
  checkDomainDns,
  generateDomain,
  removeDomain,
  reconnectDomainTunnel,
  retryCertificate,
  setDomainRoute,
  setPrimaryDomain,
  updateDomain,
} from "@/server/actions/services";
import { findCloudflareZone } from "@/server/actions/integrations";
import useSWR from "swr";
import { relativeRecordName } from "@/lib/dns-name";
import { cn } from "@/lib/utils";
import { useDebounced } from "@/hooks/use-client";

type DomainRow = {
  id: string;
  hostname: string;
  port: number | null;
  composeService: string | null;
  https: boolean;
  forceHttps: boolean;
  redirectTo: string | null;
  generated: boolean;
  /** The service's main domain: SERVE_PUBLIC_URL and links use it. */
  primary: boolean;
  cloudflare: boolean;
  managedRecord: boolean;
  /** Routed through a Cloudflare Tunnel; HTTPS is handled by Cloudflare. */
  tunnel: boolean;
  tunnelId: string | null;
  /** Meant for a tunnel; with no tunnelId it waits for one to run on the server. */
  wantsTunnel: boolean;
  /** Why the last reconnect to a tunnel failed. */
  tunnelError: string | null;
  /** Cloudflare account that manages the domain's DNS, when known. */
  cloudflareAccountId: string | null;
  certificate: { id: string; status: string; provider: string; error: string | null; expiresAt: string | null } | null;
};

type Props = {
  serviceId: string;
  /** Reverse proxy of the service's server. */
  proxyKind?: string;
  /** Host ports of the server's proxy. */
  proxyPorts?: { http: number; https: number };
  /** How Traefik's ACME resolver validates domains. */
  acmeChallenge?: "http" | "tls" | "dns-cloudflare";
  type: string;
  defaultPort: number | null;
  composeServices: string[];
  composePorts: Record<string, number[]>;
  hasCloudflare: boolean;
  hasAcme: boolean;
  serverIp: string | null;
  canGenerate: boolean;
  /** Tunnels from this service's server (one per Cloudflare account). */
  tunnels: { id: string; accountId: string; accountName: string; status: string; statusMessage: string | null }[];
  /** Name of the service's server, for messages. */
  serverName: string;
  certificates: { id: string; name: string; domains: string[]; status: string; provider: string }[];
  domains: DomainRow[];
};

type TunnelInfo = Props["tunnels"][number];

/** Live state of the tunnel a domain uses (or waits for). */
function TunnelBadge({ d, tunnels }: { d: DomainRow; tunnels: TunnelInfo[] }) {
  const t = tunnels.find((x) => x.id === d.tunnelId);
  if (!d.tunnel || !t)
    return (
      <Badge tone="bad">
        <Waypoints /> Waiting for a tunnel
      </Badge>
    );
  const state =
    t.status === "healthy"
      ? { tone: "warn" as const, label: "Tunnel" }
      : t.status === "degraded"
        ? { tone: "warn" as const, label: "Tunnel degraded" }
        : t.status === "pending"
          ? { tone: "warn" as const, label: "Tunnel starting" }
          : { tone: "bad" as const, label: "Tunnel down" };
  return (
    <Badge tone={state.tone} title={t.statusMessage ?? undefined}>
      <Waypoints /> {state.label}
    </Badge>
  );
}

/** Why a tunnel domain does not answer, and what brings it back. */
function TunnelNotice({ d, tunnels, serverName }: { d: DomainRow; tunnels: TunnelInfo[]; serverName: string }) {
  const t = tunnels.find((x) => x.id === d.tunnelId);
  let text: string | null = null;
  if (d.tunnel && t && (t.status === "down" || t.status === "error"))
    text = `The tunnel is ${t.status === "error" ? "failing" : "down"}${t.statusMessage ? `: ${t.statusMessage}` : ""}. Serve restarts its connector; check Integrations → Cloudflare.`;
  else if (d.wantsTunnel && !d.tunnel) {
    text = d.tunnelError
      ? `Reconnecting failed: ${d.tunnelError}. Fix it, then use Reconnect to tunnel.`
      : tunnels.length
        ? `No tunnel on ${serverName} belongs to the Cloudflare account that manages ${d.hostname}. Connect that account and create a tunnel; Serve reconnects this domain automatically.`
        : `${serverName} has no Cloudflare Tunnel. Connect Cloudflare and create a tunnel for this server; Serve reconnects this domain automatically.`;
  }
  if (!text) return null;
  return <p className="mt-1 max-w-2xl rounded-lg bg-bad-soft px-2.5 py-1.5 text-xs leading-relaxed text-fg-2">{text}</p>;
}

function HttpsState({ d, hasAcme, proxyKind = "nginx" }: { d: DomainRow; hasAcme: boolean; proxyKind?: string }) {
  if (d.wantsTunnel && !d.tunnel)
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-bad">
        <LockOpen className="size-3.5" /> Offline until a tunnel runs
      </span>
    );
  if (d.tunnel)
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-ok">
        <Lock className="size-3.5" /> HTTPS by Cloudflare
      </span>
    );
  if (!d.https)
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-muted">
        <LockOpen className="size-3.5" /> HTTP only
      </span>
    );
  const c = d.certificate;
  if (proxyKind === "none")
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-muted">
        <LockOpen className="size-3.5" /> No proxy
      </span>
    );
  // Caddy and Traefik obtain certificates themselves.
  if (!c && proxyKind !== "nginx") {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-ok">
        <Lock className="size-3.5" /> Certificate by {proxyKind === "caddy" ? "Caddy" : "Traefik"}
      </span>
    );
  }
  if (!c) {
    return (
      <Tooltip content={hasAcme ? "A certificate will be requested" : "Add a Let's Encrypt email in Server settings"}>
        <span className="inline-flex items-center gap-1.5 text-xs text-warn">
          <Led color="var(--warn)" /> {hasAcme ? "Waiting for certificate" : "No certificate"}
        </span>
      </Tooltip>
    );
  }
  if (c.status === "active")
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-ok">
        <Lock className="size-3.5" /> Secured
      </span>
    );
  if (c.status === "failed" || c.status === "expired")
    return (
      <Tooltip content={c.error ?? "Certificate request failed"}>
        <span className="inline-flex items-center gap-1.5 text-xs text-bad">
          <Led color="var(--bad)" /> Certificate {c.status}
        </span>
      </Tooltip>
    );
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-info">
      <Led color="var(--info)" pulse /> Issuing certificate
    </span>
  );
}

function DnsBadge({ domainId }: { domainId: string }) {
  const {
    data: state,
    isValidating: loading,
    mutate,
  } = useSWR(
    ["dns", domainId],
    async () => {
      const res = await checkDomainDns(domainId);
      return res.ok ? res.data : null;
    },
    { revalidateOnFocus: false },
  );
  const check = () => void mutate();
  const map: Record<string, { tone: "ok" | "info" | "bad" | "warn" | "neutral"; label: string }> = {
    ok: { tone: "ok", label: "DNS OK" },
    proxied: { tone: "info", label: "Cloudflare proxy" },
    wrong: { tone: "bad", label: "Points elsewhere" },
    missing: { tone: "warn", label: "No DNS record" },
    unknown: { tone: "neutral", label: "DNS unknown" },
  };
  const m = state ? map[state.status] : null;
  return (
    <Tooltip content={state?.records.length ? `Resolves to ${state.records.join(", ")}` : "Checks public DNS"}>
      <button type="button" onClick={check} className="inline-flex">
        <Badge tone={m?.tone ?? "neutral"}>{loading && !m ? "Checking…" : m?.label}</Badge>
      </button>
    </Tooltip>
  );
}

const CHALLENGE: Record<string, string> = { http: "HTTP challenge", tls: "TLS-ALPN challenge", "dns-cloudflare": "Cloudflare DNS" };

/** Card subtitle for the server's proxy. */
function proxySubtitle(kind = "nginx") {
  if (kind === "none") return "No proxy on this server — use published ports or your own proxy.";
  if (kind === "caddy") return "Traffic reaches your service through Caddy, which handles HTTPS automatically.";
  if (kind === "traefik") return "Traffic reaches your service through Traefik.";
  return "Traffic reaches your service through the built-in nginx proxy.";
}

function httpsDescription(props: Props) {
  if (props.proxyKind === "caddy") return "Caddy obtains and renews the certificate automatically and redirects HTTP to HTTPS.";
  if (props.proxyKind === "traefik") {
    return props.hasAcme
      ? `Traefik's ACME resolver (${CHALLENGE[props.acmeChallenge ?? "http"]}) issues the certificate and HTTP redirects to HTTPS.`
      : "Add a Let's Encrypt email in Server settings so Traefik can request certificates.";
  }
  return props.hasAcme ? "Get a free certificate and redirect HTTP to HTTPS." : "Add a Let's Encrypt email in Server settings to enable automatic certificates.";
}

/** Why Let's Encrypt cannot validate the domain over the network, or null when it can. */
function challengeProblem(props: Props, viaDns: boolean) {
  const kind = props.proxyKind ?? "nginx";
  if (kind === "none" || viaDns) return null;
  const tls = kind === "traefik" && props.acmeChallenge === "tls";
  if (kind === "traefik" && props.acmeChallenge === "dns-cloudflare") return null;
  const port = tls ? 443 : 80;
  const actual = tls ? props.proxyPorts?.https : props.proxyPorts?.http;
  if (!props.serverIp) return "This server has no public IP, so Let's Encrypt cannot reach it to validate the domain.";
  if (actual && actual !== port) return `The proxy listens on port ${actual} instead of ${port}, so Let's Encrypt cannot validate the domain.`;
  return null;
}

/** The record to add at the DNS provider, with copy buttons. */
function DnsRecordTable({ hostname, ip }: { hostname: string; ip: string }) {
  // Most providers want the name relative to the zone: "app" for app.example.com, "@" for the apex.
  const relative = relativeRecordName(hostname);
  const cell = "flex min-w-0 items-center gap-1.5 px-3 py-2.5";
  return (
    <div className="flex flex-col gap-2">
      <p className="text-[13px] font-medium text-fg">Add this record at your DNS provider</p>
      <div className="overflow-hidden rounded-xl border border-line text-[13px]">
        <div className="grid grid-cols-[4rem_minmax(0,1fr)_minmax(0,1.2fr)_4rem] bg-surface-2 text-[11px] font-medium tracking-wide text-muted uppercase">
          <span className="px-3 py-2">Type</span>
          <span className="px-3 py-2">Name</span>
          <span className="px-3 py-2">Value</span>
          <span className="px-3 py-2">TTL</span>
        </div>
        <div className="grid grid-cols-[4rem_minmax(0,1fr)_minmax(0,1.2fr)_4rem] border-t border-line font-mono text-[12.5px]">
          <span className={cell}>A</span>
          <span className={cell}>
            <span className="truncate" title={hostname}>
              {relative}
            </span>
            <CopyButton value={relative} />
          </span>
          <span className={cell}>
            <span className="truncate">{ip}</span>
            <CopyButton value={ip} />
          </span>
          <span className={cn(cell, "font-sans text-muted")}>Auto</span>
        </div>
      </div>
      <p className="text-xs leading-relaxed text-muted">
        Name is relative to your domain{relative !== "@" ? ` (${hostname})` : ""}; some providers want the full name instead. Changes can take a few minutes.
      </p>
    </div>
  );
}

function AddDomainDialog({ props, open, onOpenChange }: { props: Props; open: boolean; onOpenChange: (o: boolean) => void }) {
  const [hostname, setHostname] = React.useState("");
  const [https, setHttps] = React.useState(true);
  const [port, setPort] = React.useState(() => (props.type === "compose" ? String(props.composePorts[props.composeServices[0] ?? ""]?.[0] ?? "") : ""));
  const [composeService, setComposeService] = React.useState(props.composeServices[0] ?? "");
  const defaultPortFor = (svc: string) => String(props.composePorts[svc]?.[0] ?? "");
  const [createRecord, setCreateRecord] = React.useState(true);
  const [proxied, setProxied] = React.useState(true);
  const [redirect, setRedirect] = React.useState("");
  const [mode, setMode] = React.useState<"route" | "redirect">("route");

  const [step, setStep] = React.useState<1 | 2>(1);
  const lookup = useDebounced(hostname, 500);
  const { data: zoneData, isLoading: zoneLoading } = useSWR(props.hasCloudflare && /\.[a-z]{2,}$/i.test(lookup) ? ["cf-zone", lookup] : null, async () => {
    const res = await findCloudflareZone(lookup);
    return res.ok ? res.data : null;
  });
  const zone = props.hasCloudflare && /\.[a-z]{2,}$/i.test(hostname) ? (zoneData ?? null) : null;
  const tunnel = zone ? props.tunnels.find((t) => t.accountId === zone.accountId) : undefined;
  // A tunnel, when the domain's Cloudflare account has one, is the default: it needs no public IP or open port.
  const [chosenRoute, setRoute] = React.useState<"ip" | "tunnel" | null>(null);
  const route = chosenRoute ?? (tunnel ? "tunnel" : "ip");
  const viaTunnel = !!tunnel && route === "tunnel";
  const validHost = /^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(hostname);
  const step1Done = validHost && (mode === "redirect" ? !!redirect.trim() : props.type !== "compose" || (!!composeService && !!port));
  const close = (o: boolean) => {
    onOpenChange(o);
    if (!o) {
      setStep(1);
      setRoute(null);
    }
  };

  const { run, pending } = useAction(
    () =>
      addDomain(props.serviceId, {
        hostname,
        https,
        forceHttps: true,
        port: port ? Number(port) : null,
        composeService: props.type === "compose" ? composeService : null,
        redirectTo: mode === "redirect" ? redirect : null,
        cloudflare: zone && !viaTunnel ? { accountId: zone.accountId, zoneId: zone.zoneId, proxied, createRecord } : null,
        tunnelId: viaTunnel ? tunnel!.id : null,
      }),
    {
      onSuccess: (d) => {
        if (d.warning) toast.warning("Domain added", d.warning);
        else toast.success("Domain added");
        close(false);
        setHostname("");
      },
    },
  );

  const routeCard = (r: "tunnel" | "ip") => (
    <button
      key={r}
      type="button"
      onClick={() => setRoute(r)}
      className={cn(
        "flex items-start gap-3 rounded-xl border p-3.5 text-left transition-colors",
        route === r ? "border-accent bg-accent-soft/40 ring-1 ring-accent/30" : "border-line bg-surface hover:border-line-strong",
      )}
    >
      <span className={cn("mt-0.5 flex size-4 flex-none items-center justify-center rounded-full border", route === r ? "border-accent" : "border-line-strong")}>
        {route === r && <span className="size-2 rounded-full bg-accent" />}
      </span>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="flex items-center gap-1.5 text-[13px] font-medium text-fg">
          {r === "tunnel" ? <Waypoints className="size-3.5 text-[#f38020]" /> : <Globe className="size-3.5 text-muted" />}
          {r === "tunnel" ? "Cloudflare Tunnel" : "Server IP"}
          {r === "tunnel" && <Badge tone="info">Recommended</Badge>}
        </span>
        <span className="text-xs leading-relaxed text-muted">
          {r === "tunnel"
            ? `Through the tunnel in ${tunnel?.accountName}. HTTPS by Cloudflare; no public IP or open port needed.`
            : props.serverIp
              ? `Visitors connect to ${props.serverIp}. Ports 80 and 443 must be reachable.`
              : "Visitors connect to the server's public IP. Set it in the server settings first."}
        </span>
      </span>
    </button>
  );

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (step === 1) {
              if (step1Done) setStep(2);
              return;
            }
            void run();
          }}
        >
          <DialogHeader
            title={step === 1 ? "Add domain" : hostname}
            description={
              step === 1
                ? props.proxyKind === "none"
                  ? "Point a domain at this service. This server runs no proxy, so the domain is saved but not served."
                  : props.proxyKind === "caddy"
                    ? "Point a domain at this service. Caddy obtains and renews the certificate automatically."
                    : props.proxyKind === "traefik"
                      ? "Point a domain at this service. Traefik issues and renews the certificate."
                      : "Point a domain at this service. HTTPS certificates are issued automatically."
                : mode === "redirect"
                  ? `Redirects to ${redirect}`
                  : "Choose how visitors reach this domain."
            }
          />
          <DialogBody>
            <p className="-mt-1 text-[11px] font-medium tracking-wide text-faint uppercase">
              Step {step} of 2 · {step === 1 ? "Domain" : "Connection"}
            </p>
            {step === 1 ? (
              <>
                <Field label="Domain">
                  <Input
                    value={hostname}
                    onChange={(e) => setHostname(e.target.value.trim().toLowerCase())}
                    placeholder="app.example.com"
                    autoFocus
                    required
                    className="font-mono text-[13px]"
                  />
                </Field>
                <div className="grid grid-cols-2 gap-1 rounded-xl bg-sunken p-1">
                  {(["route", "redirect"] as const).map((m) => (
                    <button
                      key={m}
                      type="button"
                      onClick={() => setMode(m)}
                      className={`h-8 rounded-lg text-[13px] font-medium transition-all ${mode === m ? "bg-surface text-fg shadow-sm" : "text-muted hover:text-fg"}`}
                    >
                      {m === "route" ? "Route to this service" : "Redirect to a URL"}
                    </button>
                  ))}
                </div>
                {mode === "redirect" ? (
                  <Field label="Redirect to" description="Visitors are sent to this URL with a permanent redirect.">
                    <Input value={redirect} onChange={(e) => setRedirect(e.target.value)} placeholder="https://www.example.com" required />
                  </Field>
                ) : (
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    {props.type === "compose" && (
                      <Field label="Compose service">
                        <Select
                          value={composeService}
                          onValueChange={(v) => {
                            setComposeService(v);
                            setPort(defaultPortFor(v));
                          }}
                          options={props.composeServices.map((s) => ({ value: s, label: s }))}
                        />
                      </Field>
                    )}
                    <Field
                      label="Container port"
                      optional={props.type !== "compose"}
                      description={props.type === "app" && props.defaultPort ? `Defaults to ${props.defaultPort}` : undefined}
                    >
                      <Input
                        value={port}
                        onChange={(e) => setPort(e.target.value.replace(/\D/g, ""))}
                        placeholder={String(props.defaultPort ?? 80)}
                        inputMode="numeric"
                        required={props.type === "compose"}
                      />
                    </Field>
                  </div>
                )}
              </>
            ) : (
              <>
                {zoneLoading && !zoneData && <p className="text-xs text-muted">Looking for {hostname} in your Cloudflare accounts…</p>}
                {tunnel && <div className="grid grid-cols-1 gap-2">{(["tunnel", "ip"] as const).map(routeCard)}</div>}
                {viaTunnel ? (
                  <div className="flex gap-2.5 rounded-xl border border-line bg-surface-2 p-4 text-[13px] leading-relaxed text-fg-2">
                    <Waypoints className="mt-0.5 size-4 flex-none text-[#f38020]" />
                    <p>
                      Serve points <span className="font-mono text-fg">{hostname}</span> at the tunnel in {tunnel!.accountName}. Cloudflare serves it over HTTPS, so no certificate
                      or open port is needed.
                    </p>
                  </div>
                ) : props.proxyKind === "none" ? (
                  <div className="flex gap-2.5 rounded-xl border border-line bg-surface-2 p-4 text-[13px] leading-relaxed text-fg-2">
                    <Globe className="mt-0.5 size-4 flex-none text-muted" />
                    <p>No proxy on this server — use published ports or your own proxy. Serve saves the domain and serves it again when a proxy runs.</p>
                  </div>
                ) : (
                  <>
                    <SwitchRow title="HTTPS" description={httpsDescription(props)} checked={https} onCheckedChange={setHttps} />
                    {https && !!hostname && challengeProblem(props, !!zone && (props.proxyKind ?? "nginx") === "nginx") && (
                      <p className="rounded-xl border border-warn/25 bg-warn-soft px-3.5 py-2.5 text-xs leading-relaxed text-fg-2">
                        {challengeProblem(props, !!zone && (props.proxyKind ?? "nginx") === "nginx")} Route the domain through a Cloudflare Tunnel
                        {props.proxyKind === "traefik"
                          ? " or use the Cloudflare DNS challenge (Server → Proxy)"
                          : props.proxyKind === "caddy"
                            ? ""
                            : " or add it from a Cloudflare zone for DNS validation"}
                        .
                      </p>
                    )}
                  </>
                )}
                {zone && !viaTunnel && (
                  <div className="flex flex-col gap-3 rounded-xl border border-line bg-surface-2 p-4">
                    <div className="flex items-center gap-2 text-[13px] font-medium text-fg">
                      <Cloud className="size-4 text-[#f38020]" /> Found {zone.zoneName} in Cloudflare ({zone.accountName})
                    </div>
                    <SwitchRow
                      title="Create the DNS record"
                      description={props.serverIp ? `A record → ${props.serverIp}` : "Set the server IP in Server settings first."}
                      checked={createRecord}
                      onCheckedChange={setCreateRecord}
                    />
                    <SwitchRow
                      title="Proxy through Cloudflare"
                      description="Orange cloud. Hides your server IP and adds Cloudflare's CDN and DDoS protection."
                      checked={proxied}
                      onCheckedChange={setProxied}
                    />
                    {https && (props.proxyKind ?? "nginx") === "nginx" && (
                      <p className="text-xs text-muted">The certificate is validated through Cloudflare DNS, so it works even when proxied.</p>
                    )}
                  </div>
                )}
                {!zone && hostname && props.tunnels.length > 0 && (
                  <p className="text-xs leading-relaxed text-muted">
                    Domains in {props.tunnels.map((t) => t.accountName).join(" or ")} can use the Cloudflare Tunnel of this server.
                  </p>
                )}
                {!zone && hostname && props.serverIp && !viaTunnel && <DnsRecordTable hostname={hostname} ip={props.serverIp} />}
              </>
            )}
          </DialogBody>
          <DialogFooter>
            {step === 1 ? (
              <>
                <DialogClose render={<Button variant="ghost" size="sm" />}>Cancel</DialogClose>
                <Button type="submit" variant="primary" size="sm" disabled={!step1Done}>
                  Continue
                </Button>
              </>
            ) : (
              <>
                <Button type="button" variant="ghost" size="sm" onClick={() => setStep(1)}>
                  Back
                </Button>
                <Button type="submit" variant="primary" size="sm" loading={pending}>
                  Add domain
                </Button>
              </>
            )}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Change where a domain routes: the compose service and the container port. */
function EditDomainDialog({ props, domain, onClose }: { props: Props; domain: DomainRow; onClose: () => void }) {
  const compose = props.type === "compose";
  const [composeService, setComposeService] = React.useState(domain.composeService ?? props.composeServices[0] ?? "");
  const [port, setPort] = React.useState(domain.port ? String(domain.port) : "");
  const save = useAction(() => updateDomain(domain.id, { port: port ? Number(port) : null, ...(compose ? { composeService: composeService || null } : {}) }), {
    success: "Domain updated",
    onSuccess: onClose,
  });
  const submit = async () => {
    const wantTunnel = route === "tunnel";
    const usesTunnel = domain.tunnel || domain.wantsTunnel;
    if (wantTunnel && !domain.tunnel) {
      if (!tunnel) {
        // Still waiting for a tunnel: nothing to change; otherwise there is no tunnel to switch to.
        if (!domain.wantsTunnel)
          return void toast.error("No tunnel can serve this domain", `Create a Cloudflare Tunnel on ${props.serverName} for the account that manages ${domain.hostname}.`);
      } else if ((await reroute.run(tunnel.id)) === undefined) return;
    } else if (!wantTunnel && usesTunnel) {
      // run() resolves to undefined when the action failed (the error is already shown).
      if ((await reroute.run(null)) === undefined) return;
    }
    await save.run();
  };
  const detected = compose ? (props.composePorts[composeService] ?? []) : [];
  const [route, setRoute] = React.useState<"ip" | "tunnel">(domain.tunnel || domain.wantsTunnel ? "tunnel" : "ip");
  // The tunnel of the Cloudflare account that manages this domain: known account first, else a zone lookup.
  const known = props.tunnels.find((t) => t.id === domain.tunnelId) ?? props.tunnels.find((t) => t.accountId === domain.cloudflareAccountId);
  const { data: zone } = useSWR(!known && props.tunnels.length ? ["cf-zone", domain.hostname] : null, async () => {
    const res = await findCloudflareZone(domain.hostname);
    return res.ok ? res.data : null;
  });
  const tunnel = known ?? (zone ? props.tunnels.find((t) => t.accountId === zone.accountId) : undefined);
  const reroute = useAction((to: string | null) => setDomainRoute(domain.id, to), {
    onSuccess: (r) => {
      if (r?.warning) toast.warning("Route updated", r.warning);
      else toast.success("Route updated. DNS points to the new target.");
    },
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <DialogHeader title={`Edit ${domain.hostname}`} description="Where traffic for this domain goes. Applies right away; no redeploy needed." />
          <DialogBody>
            {(props.tunnels.length > 0 || domain.wantsTunnel) && (
              <Field
                label="Route traffic through"
                description={
                  route === "tunnel"
                    ? "Cloudflare serves HTTPS and forwards to this server through the tunnel. No public IP or open port needed."
                    : "Visitors connect to the server's public IP. Ports 80 and 443 must be reachable."
                }
              >
                <div className="grid grid-cols-2 gap-1 rounded-xl bg-sunken p-1">
                  {(["ip", "tunnel"] as const).map((r) => (
                    <button
                      key={r}
                      type="button"
                      onClick={() => setRoute(r)}
                      className={cn(
                        "inline-flex h-8 items-center justify-center gap-1.5 rounded-lg text-[13px] transition-colors",
                        route === r ? "bg-surface font-medium text-fg shadow-sm" : "text-muted hover:text-fg",
                      )}
                    >
                      {r === "tunnel" ? <Waypoints className="size-3.5 text-[#f38020]" /> : <Globe className="size-3.5" />}
                      {r === "tunnel" ? "Cloudflare Tunnel" : "Server IP"}
                    </button>
                  ))}
                </div>
              </Field>
            )}
            {compose && (
              <Field label="Compose service">
                <Select
                  value={composeService}
                  onValueChange={(v) => {
                    setComposeService(v);
                    const first = props.composePorts[v]?.[0];
                    if (first) setPort(String(first));
                  }}
                  options={props.composeServices.map((s) => ({
                    value: s,
                    label: s,
                    description: props.composePorts[s]?.length ? `Ports ${props.composePorts[s].join(", ")}` : undefined,
                  }))}
                />
              </Field>
            )}
            <Field
              label="Container port"
              optional={!compose}
              description={
                detected.length
                  ? `Found in the compose file: ${detected.join(", ")}`
                  : !compose && props.defaultPort
                    ? `Empty uses the service port (${props.defaultPort}).`
                    : "The port the app listens on inside the container."
              }
            >
              <Input
                value={port}
                onChange={(e) => setPort(e.target.value.replace(/\D/g, ""))}
                placeholder={String(props.defaultPort ?? 80)}
                inputMode="numeric"
                required={compose}
              />
            </Field>
          </DialogBody>
          <DialogFooter>
            <DialogClose render={<Button variant="ghost" size="sm" />}>Cancel</DialogClose>
            <Button type="submit" variant="primary" size="sm" loading={save.pending || reroute.pending}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function DomainsManager(props: Props) {
  const [open, setOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<DomainRow | null>(null);
  const confirm = useConfirm();
  const generate = useAction(() => generateDomain(props.serviceId), { success: "Domain generated" });
  const remove = useAction((id: string, dns: boolean) => removeDomain(id, dns), { success: "Domain removed" });
  const toggleHttps = useAction((id: string, https: boolean) => updateDomain(id, { https, forceHttps: https }), { success: "Domain updated" });
  const retry = useAction(retryCertificate, { success: "Requesting a new certificate" });
  const reconnect = useAction(reconnectDomainTunnel, { success: "Reconnected to the tunnel" });
  const makePrimary = useAction(setPrimaryDomain, { success: "Primary domain set. Redeploy so SERVE_PUBLIC_URL uses it." });

  return (
    <Card className="overflow-hidden">
      <CardHeader
        title="Domains"
        description={proxySubtitle(props.proxyKind)}
        actions={
          <>
            {props.canGenerate && (
              <Button size="sm" onClick={() => generate.run()} loading={generate.pending}>
                <Sparkles /> Generate
              </Button>
            )}
            <Button size="sm" variant="primary" onClick={() => setOpen(true)}>
              <Plus /> Add domain
            </Button>
          </>
        }
      />
      {props.domains.length === 0 ? (
        <EmptyState icon={<Globe />} title="No domains yet" description="Add your own domain or generate a free one to make this service reachable." />
      ) : (
        <div className="divide-y divide-line">
          {props.domains.map((d) => (
            <div key={d.id} className="flex items-start gap-3 px-4 py-4 sm:gap-4 sm:px-5">
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                  <a
                    href={`${d.https || d.tunnel ? "https" : "http"}://${d.hostname}`}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex min-w-0 max-w-full items-center gap-1 text-[14px] font-medium text-fg hover:text-accent"
                  >
                    <span className="truncate">{d.hostname}</span>
                    <ArrowUpRight className="size-3.5 shrink-0 text-faint" />
                  </a>
                  {d.primary && (
                    <Badge tone="info">
                      <Star /> Primary
                    </Badge>
                  )}
                  {d.generated && <Badge>Generated</Badge>}
                  {d.tunnel || d.wantsTunnel ? (
                    <TunnelBadge d={d} tunnels={props.tunnels} />
                  ) : (
                    d.cloudflare && (
                      <Badge tone="warn">
                        <Cloud /> Cloudflare
                      </Badge>
                    )
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
                  {d.redirectTo ? (
                    <span className="inline-flex items-center gap-1">
                      <CornerDownRight className="size-3" /> Redirects to {d.redirectTo}
                    </span>
                  ) : (
                    <span className="font-mono">
                      → {d.composeService ? `${d.composeService}:` : "port "}
                      {d.port ?? props.defaultPort ?? 80}
                    </span>
                  )}
                  <HttpsState d={d} hasAcme={props.hasAcme} proxyKind={props.proxyKind} />
                </div>
                <TunnelNotice d={d} tunnels={props.tunnels} serverName={props.serverName} />
              </div>
              <div className="flex flex-none items-center gap-2 pt-0.5">
                <DnsBadge domainId={d.id} />
                <Menu>
                  <MenuTrigger className="rounded-lg p-1.5 text-muted hover:bg-hover hover:text-fg" aria-label="Domain actions">
                    <MoreHorizontal className="size-4" />
                  </MenuTrigger>
                  <MenuContent>
                    {d.wantsTunnel && !d.tunnel && (
                      <>
                        <MenuItem onClick={() => reconnect.run(d.id)}>
                          <RefreshCw /> Reconnect to tunnel
                        </MenuItem>
                        <MenuSeparator />
                      </>
                    )}
                    {!d.redirectTo && (
                      <MenuItem onClick={() => setEditing(d)}>
                        <Pencil /> Edit
                      </MenuItem>
                    )}
                    {!d.primary && !d.redirectTo && (
                      <>
                        <MenuItem onClick={() => makePrimary.run(d.id)}>
                          <Star /> Make primary
                        </MenuItem>
                        <MenuSeparator />
                      </>
                    )}
                    {/* Tunnel domains get HTTPS from Cloudflare; there is nothing to toggle. */}
                    {!d.tunnel && !d.wantsTunnel && (
                      <>
                        <MenuItem onClick={() => toggleHttps.run(d.id, !d.https)}>
                          {d.https ? <LockOpen /> : <Lock />} {d.https ? "Use HTTP only" : "Enable HTTPS"}
                        </MenuItem>
                        {d.https && d.certificate?.status !== "active" && (
                          <MenuItem onClick={() => retry.run(d.id)}>
                            <RefreshCw /> Retry certificate
                          </MenuItem>
                        )}
                        <MenuSeparator />
                      </>
                    )}
                    <MenuItem
                      danger
                      onClick={async () => {
                        if (
                          await confirm({
                            title: `Remove ${d.hostname}?`,
                            description: d.managedRecord ? "The DNS record Serve created in Cloudflare is deleted too." : "The domain stops routing to this service.",
                            confirmLabel: "Remove domain",
                            danger: true,
                          })
                        )
                          remove.run(d.id, true);
                      }}
                    >
                      <Trash2 /> Remove
                    </MenuItem>
                  </MenuContent>
                </Menu>
              </div>
            </div>
          ))}
        </div>
      )}
      <AddDomainDialog props={props} open={open} onOpenChange={setOpen} />
      {editing && <EditDomainDialog key={editing.id} props={props} domain={editing} onClose={() => setEditing(null)} />}
    </Card>
  );
}
