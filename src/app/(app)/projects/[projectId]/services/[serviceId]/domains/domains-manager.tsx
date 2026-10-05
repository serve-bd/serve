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
import { useAction, showError } from "@/hooks/use-action";
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
import { findCloudflareZone, refreshTunnels } from "@/server/actions/integrations";
import { checkDomainOwnership } from "@/server/actions/verified-domains";
import { DomainProof } from "@/components/domain-proof";
import useSWR from "swr";
import { relativeRecordName } from "@/lib/dns-name";
import { cn } from "@/lib/utils";
import { useCan } from "@/components/permissions";
import { cannotMessage } from "@/lib/permissions";
import { useDebounced } from "@/hooks/use-client";
import { setMainServer } from "@/server/actions/main-server";
import { type EntryDomain, type EntryServer, entryPlan, entryProblem } from "@/server/services/entry-plan";
import { EntryPlanNotice, EntryServerOption, entryWays, MainServerDialog, reportMainServer } from "../main-server";

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
  /** The certificate picked for this domain; null lets the proxy match one by name. */
  certificateId: string | null;
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
  /** Not deployed yet: certificates are requested on the first deploy. */
  undeployed?: boolean;
  serverIp: string | null;
  canGenerate: boolean;
  /** Tunnels from this service's server (one per Cloudflare account). */
  tunnels: { id: string; accountId: string; accountName: string; status: string; statusMessage: string | null }[];
  /** Routing a domain through a tunnel is for organization admins only. */
  isAdmin: boolean;
  /** Name of the service's server, for messages. */
  serverName: string;
  /** `here`: stored on this service's server, the only ones its proxy can serve. */
  certificates: { id: string; name: string; domains: string[]; status: string; provider: string; serverId: string; serverName: string; here: boolean }[];
  domains: DomainRow[];
  /** An app on several servers: each of them, main first, and its domains as a switch reads them. */
  entryServers?: EntryServer[];
  entryDomains?: EntryDomain[];
};

/** The dialog's view of another server: its proxy, address, tunnels and certificates. */
function withEntry(props: Props, e: EntryServer): Props {
  return {
    ...props,
    proxyKind: e.proxyKind,
    proxyPorts: e.proxyPorts,
    acmeChallenge: e.acmeChallenge,
    serverIp: e.publicIp,
    serverName: e.name,
    tunnels: e.tunnels.map((t) => ({ id: t.id, accountId: t.accountId, accountName: t.accountName ?? "Cloudflare", status: t.status ?? "pending", statusMessage: null })),
    certificates: props.certificates.map((c) => ({ ...c, here: c.serverId === e.id })),
  };
}

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
    text = `The tunnel is ${t.status === "error" ? "failing" : "down"}${t.statusMessage ? `: ${t.statusMessage}` : ""}. The connector restarts automatically; check Integrations → Cloudflare.`;
  else if (d.wantsTunnel && !d.tunnel) {
    text = d.tunnelError
      ? `Reconnecting failed: ${d.tunnelError}. Fix it, then use Reconnect to tunnel.`
      : tunnels.length
        ? `No tunnel on ${serverName} belongs to the Cloudflare account that manages ${d.hostname}. Connect that account and create a tunnel; this domain reconnects automatically.`
        : `${serverName} has no Cloudflare Tunnel. Connect Cloudflare and create a tunnel for this server; this domain reconnects automatically.`;
  }
  if (!text) return null;
  return <p className="mt-1 max-w-2xl rounded-lg bg-bad-soft px-2.5 py-1.5 text-xs leading-relaxed text-fg-2">{text}</p>;
}

function HttpsState({ d, hasAcme, undeployed, proxyKind = "nginx" }: { d: DomainRow; hasAcme: boolean; undeployed?: boolean; proxyKind?: string }) {
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
  if (!c && undeployed && hasAcme) {
    return (
      <Tooltip content="Serve asks for the certificate when the service is deployed for the first time.">
        <span className="inline-flex items-center gap-1.5 text-xs text-muted">
          <Lock className="size-3.5" /> Certificate on first deploy
        </span>
      </Tooltip>
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

/** Whether a certificate's names cover a hostname (exact, or one wildcard level). */
function certCovers(names: string[], host: string) {
  return names.some((n) => n === host || (n.startsWith("*.") && host.endsWith(n.slice(1)) && !host.slice(0, -n.length + 1).includes(".")));
}

/** How the domain is secured: a free certificate, a stored one, or plain HTTP behind the user's own TLS. */
function TlsChoice({
  props,
  hostname,
  value,
  onChange,
  certificateId,
  onCertificate,
}: {
  props: Props;
  hostname: string;
  value: "auto" | "custom" | "none";
  onChange: (v: "auto" | "custom" | "none") => void;
  certificateId: string;
  onCertificate: (id: string) => void;
}) {
  const matching = props.certificates.filter((c) => !c.provider.startsWith("letsencrypt") && c.status === "active" && certCovers(c.domains, hostname));
  const own = matching.filter((c) => c.here);
  const elsewhere = own.length ? null : matching.find((c) => !c.here);
  const options: { id: "auto" | "custom" | "none"; title: string; body: string }[] = [
    { id: "auto", title: "HTTPS, free certificate", body: httpsDescription(props) },
    ...(own.length || value === "custom" ? [{ id: "custom" as const, title: "HTTPS, my certificate", body: "Use a certificate you uploaded in Certificates." }] : []),
    { id: "none", title: "HTTP only", body: "No certificate. For when your own proxy, load balancer or CDN in front handles HTTPS." },
  ];
  return (
    <div className="flex flex-col gap-2">
      <span className="text-[13px] font-medium text-fg">Security</span>
      <div className="flex flex-col gap-2" role="radiogroup" aria-label="Security">
        {options.map((o) => (
          <button
            key={o.id}
            type="button"
            role="radio"
            aria-checked={value === o.id}
            onClick={() => {
              onChange(o.id);
              if (o.id === "custom" && !certificateId && own[0]) onCertificate(own[0].id);
            }}
            className={cn(
              "flex items-start gap-3 rounded-xl border p-3 text-left transition-colors",
              value === o.id ? "border-accent bg-accent-soft/40" : "border-line hover:border-line-strong",
            )}
          >
            <span className={cn("mt-0.5 flex size-4 flex-none items-center justify-center rounded-full border", value === o.id ? "border-accent" : "border-line-strong")}>
              {value === o.id && <span className="size-2 rounded-full bg-accent" />}
            </span>
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="text-[13px] font-medium text-fg">{o.title}</span>
              <span className="text-xs leading-relaxed text-muted">{o.body}</span>
            </span>
          </button>
        ))}
      </div>
      {elsewhere && (
        <p className="text-xs leading-relaxed text-muted">
          Your certificate {elsewhere.name} is stored on {elsewhere.serverName}. Upload it for {props.serverName} too in Certificates to use it here.
        </p>
      )}
      {value === "custom" && own.length > 0 && (
        <Select value={certificateId} onValueChange={onCertificate} options={own.map((c) => ({ value: c.id, label: c.name, description: c.domains.join(", ") }))} />
      )}
      {value === "none" && (
        <p className="text-xs leading-relaxed text-muted">
          Point your proxy at this server&apos;s HTTP port and pass <span className="font-mono">X-Forwarded-Proto: https</span>; the app then sees the request as HTTPS.
        </p>
      )}
    </div>
  );
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
  if (actual === 0) return "The proxy takes no ports on this server, so Let's Encrypt cannot reach it. Use a Cloudflare Tunnel or the Cloudflare DNS check.";
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
  // Apps on several servers: visitors enter through one of them, picked here. The options below
  // (tunnels, IP, certificates) are those of the picked server.
  const entries = props.entryServers ?? [];
  const mainEntry = entries.find((e) => e.main);
  const [entryId, setEntryId] = React.useState(mainEntry?.id ?? "");
  const entry = entries.length > 1 ? entries.find((e) => e.id === entryId) : undefined;
  const switching = !!entry && !entry.main;
  const p: Props = entry && switching ? withEntry(props, entry) : props;
  const entryBlocked = !!entry && (switching ? !!entryProblem(entry) || entryPlan(entry, props.entryDomains ?? []).blockers.length > 0 : false);
  const [hostname, setHostname] = React.useState("");
  // auto: the proxy gets a free certificate; custom: a stored certificate; none: plain HTTP, TLS ends in front of Serve.
  const [tls, setTls] = React.useState<"auto" | "custom" | "none">("auto");
  const [certificateId, setCertificateId] = React.useState<string>("");
  const https = tls !== "none";
  const [port, setPort] = React.useState(() => (p.type === "compose" ? String(p.composePorts[p.composeServices[0] ?? ""]?.[0] ?? "") : ""));
  const [composeService, setComposeService] = React.useState(p.composeServices[0] ?? "");
  const defaultPortFor = (svc: string) => String(p.composePorts[svc]?.[0] ?? "");
  const [createRecord, setCreateRecord] = React.useState(true);
  const [proxied, setProxied] = React.useState(true);
  const [redirect, setRedirect] = React.useState("");
  const [mode, setMode] = React.useState<"route" | "redirect">("route");

  const [step, setStep] = React.useState<1 | 2>(1);
  // The TXT record to add when the organization has not proved it owns the domain yet.
  const [proof, setProof] = React.useState<{ recordName: string; recordValue: string } | null>(null);
  const [checking, setChecking] = React.useState(false);
  const verifyThenContinue = async () => {
    setChecking(true);
    const res = await checkDomainOwnership(hostname).finally(() => setChecking(false));
    if (!res.ok) return void showError(res.error);
    if (res.data.verified) {
      setProof(null);
      setStep(2);
    } else setProof({ recordName: res.data.recordName, recordValue: res.data.recordValue });
  };
  const lookup = useDebounced(hostname, 500);
  const { data: zoneData, isLoading: zoneLoading } = useSWR(p.hasCloudflare && /\.[a-z]{2,}$/i.test(lookup) ? ["cf-zone", lookup] : null, async () => {
    const res = await findCloudflareZone(lookup);
    return res.ok ? res.data : null;
  });
  const zone = p.hasCloudflare && /\.[a-z]{2,}$/i.test(hostname) ? (zoneData ?? null) : null;
  const tunnel = p.isAdmin && zone ? p.tunnels.find((t) => t.accountId === zone.accountId) : undefined;
  // A tunnel, when the domain's Cloudflare account has one, is the default: it needs no public IP or open port.
  const [chosenRoute, setRoute] = React.useState<"ip" | "tunnel" | null>(null);
  const route = chosenRoute ?? (tunnel ? "tunnel" : "ip");
  const viaTunnel = !!tunnel && route === "tunnel";
  const validHost = /^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(hostname);
  const step1Done = validHost && (mode === "redirect" ? !!redirect.trim() : p.type !== "compose" || (!!composeService && !!port));
  const close = (o: boolean) => {
    onOpenChange(o);
    if (!o) {
      setStep(1);
      setRoute(null);
    }
  };

  const { run, pending } = useAction(
    async () => {
      // The other server first: the domain is then added there, with its tunnel or IP.
      if (switching) {
        const res = await setMainServer(p.serviceId, entry.id);
        if (!res.ok) return res;
        reportMainServer(res.data, entry.name);
      }
      return addDomain(p.serviceId, {
        hostname,
        https,
        forceHttps: https,
        certificateId: tls === "custom" && certificateId ? certificateId : null,
        port: port ? Number(port) : null,
        composeService: p.type === "compose" ? composeService : null,
        redirectTo: mode === "redirect" ? redirect : null,
        cloudflare: zone && !viaTunnel ? { accountId: zone.accountId, zoneId: zone.zoneId, proxied, createRecord } : null,
        tunnelId: viaTunnel ? tunnel!.id : null,
      });
    },
    {
      onSuccess: (d) => {
        if (d.warning) toast.warning("Domain added", d.warning);
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
            : p.serverIp
              ? `Visitors connect to ${p.serverIp}. Ports 80 and 443 must be reachable.`
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
              if (step1Done) void verifyThenContinue();
              return;
            }
            void run();
          }}
        >
          <DialogHeader
            title={step === 1 ? "Add domain" : hostname}
            description={
              step === 1
                ? p.proxyKind === "none"
                  ? "Point a domain at this service. This server runs no proxy, so the domain is saved but not served."
                  : p.proxyKind === "caddy"
                    ? "Point a domain at this service. Caddy obtains and renews the certificate automatically."
                    : p.proxyKind === "traefik"
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
                    onChange={(e) => {
                      setHostname(e.target.value.trim().toLowerCase());
                      setProof(null);
                    }}
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
                {proof && <DomainProof recordName={proof.recordName} recordValue={proof.recordValue} domain={hostname.replace(/^\*\./, "")} />}
                {mode === "redirect" ? (
                  <Field label="Redirect to" description="Visitors are sent to this URL with a permanent redirect.">
                    <Input value={redirect} onChange={(e) => setRedirect(e.target.value)} placeholder="https://www.example.com" required />
                  </Field>
                ) : (
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    {p.type === "compose" && (
                      <Field label="Compose service">
                        <Select
                          value={composeService}
                          onValueChange={(v) => {
                            setComposeService(v);
                            setPort(defaultPortFor(v));
                          }}
                          options={p.composeServices.map((s) => ({ value: s, label: s }))}
                        />
                      </Field>
                    )}
                    <Field label="Container port" optional={p.type !== "compose"} description={p.type === "app" && p.defaultPort ? `Defaults to ${p.defaultPort}` : undefined}>
                      <Input
                        value={port}
                        onChange={(e) => setPort(e.target.value.replace(/\D/g, ""))}
                        placeholder={String(p.defaultPort ?? 80)}
                        inputMode="numeric"
                        required={p.type === "compose"}
                      />
                    </Field>
                  </div>
                )}
              </>
            ) : (
              <>
                {entries.length > 1 && (
                  <div className="flex flex-col gap-2">
                    <span className="text-[13px] font-medium text-fg">Visitors enter through</span>
                    <div className="flex flex-col gap-2" role="radiogroup" aria-label="Visitors enter through">
                      {entries.map((e) => (
                        <EntryServerOption
                          key={e.id}
                          server={e}
                          selected={e.id === entryId}
                          onSelect={() => {
                            setEntryId(e.id);
                            setRoute(null);
                            setCertificateId("");
                          }}
                        />
                      ))}
                    </div>
                    {entry && switching && mainEntry && <EntryPlanNotice server={entry} plan={entryPlan(entry, props.entryDomains ?? [])} />}
                    {entry && !switching && entryProblem(entry) && <EntryPlanNotice server={entry} plan={{ moves: [], blockers: [] }} />}
                  </div>
                )}
                {zoneLoading && !zoneData && <p className="text-xs text-muted">Looking for {hostname} in your Cloudflare accounts…</p>}
                {tunnel && <div className="grid grid-cols-1 gap-2">{(["tunnel", "ip"] as const).map(routeCard)}</div>}
                {viaTunnel ? (
                  <div className="flex gap-2.5 rounded-xl border border-line bg-surface-2 p-4 text-[13px] leading-relaxed text-fg-2">
                    <Waypoints className="mt-0.5 size-4 flex-none text-[#f38020]" />
                    <p>
                      <span className="font-mono text-fg">{hostname}</span> points at the tunnel in {tunnel!.accountName}. Cloudflare serves it over HTTPS, so no certificate or
                      open port is needed.
                    </p>
                  </div>
                ) : p.proxyKind === "none" ? (
                  <div className="flex gap-2.5 rounded-xl border border-line bg-surface-2 p-4 text-[13px] leading-relaxed text-fg-2">
                    <Globe className="mt-0.5 size-4 flex-none text-muted" />
                    <p>No proxy on this server — use published ports or your own proxy. The domain is saved and served again when a proxy runs.</p>
                  </div>
                ) : (
                  <>
                    <TlsChoice props={p} hostname={hostname} value={tls} onChange={setTls} certificateId={certificateId} onCertificate={setCertificateId} />
                    {tls === "auto" && !!hostname && challengeProblem(p, !!zone && (p.proxyKind ?? "nginx") === "nginx") && (
                      <p className="rounded-xl border border-warn/25 bg-warn-soft px-3.5 py-2.5 text-xs leading-relaxed text-fg-2">
                        {challengeProblem(p, !!zone && (p.proxyKind ?? "nginx") === "nginx")} Route the domain through a Cloudflare Tunnel
                        {p.proxyKind === "traefik"
                          ? " or use the Cloudflare DNS challenge (Server → Proxy)"
                          : p.proxyKind === "caddy"
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
                      description={p.serverIp ? `A record → ${p.serverIp}` : "Set the server IP in Server settings first."}
                      checked={createRecord}
                      onCheckedChange={setCreateRecord}
                    />
                    <SwitchRow
                      title="Proxy through Cloudflare"
                      description="Orange cloud. Hides your server IP and adds Cloudflare's CDN and DDoS protection."
                      checked={proxied}
                      onCheckedChange={setProxied}
                    />
                    {https && (p.proxyKind ?? "nginx") === "nginx" && (
                      <p className="text-xs text-muted">The certificate is validated through Cloudflare DNS, so it works even when proxied.</p>
                    )}
                  </div>
                )}
                {!zone && hostname && p.isAdmin && p.tunnels.length > 0 && (
                  <p className="text-xs leading-relaxed text-muted">Domains in {p.tunnels.map((t) => t.accountName).join(" or ")} can use the Cloudflare Tunnel of this server.</p>
                )}
                {!zone && hostname && p.serverIp && !viaTunnel && <DnsRecordTable hostname={hostname} ip={p.serverIp} />}
              </>
            )}
          </DialogBody>
          <DialogFooter>
            {step === 1 ? (
              <>
                <DialogClose render={<Button variant="ghost" size="sm" />}>Cancel</DialogClose>
                <Button type="submit" variant="primary" size="sm" disabled={!step1Done} loading={checking}>
                  {proof ? "Check again" : "Continue"}
                </Button>
              </>
            ) : (
              <>
                <Button type="button" variant="ghost" size="sm" onClick={() => setStep(1)}>
                  Back
                </Button>
                <Button type="submit" variant="primary" size="sm" loading={pending} disabled={entryBlocked}>
                  {switching ? `Switch to ${entry.name} and add` : "Add domain"}
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
  const [tls, setTls] = React.useState<"auto" | "custom" | "none">(!domain.https ? "none" : domain.certificateId ? "custom" : "auto");
  const [certificateId, setCertificateId] = React.useState(domain.certificateId ?? "");
  const tlsChange = () => {
    const https = tls !== "none";
    return {
      https,
      // Keep the redirect setting while HTTPS stays on; turning HTTPS on redirects plain HTTP to it.
      forceHttps: https && (domain.https ? domain.forceHttps : true),
      certificateId: tls === "custom" && certificateId ? certificateId : null,
    };
  };
  const save = useAction(
    () => updateDomain(domain.id, { port: port ? Number(port) : null, ...(compose ? { composeService: composeService || null } : {}), ...(showTls ? tlsChange() : {}) }),
    {
      onSuccess: onClose,
    },
  );
  const submit = async () => {
    const wantTunnel = route === "tunnel";
    const usesTunnel = domain.tunnel || domain.wantsTunnel;
    // Only admins see (and may change) the route: for others it stays as it is.
    if (props.isAdmin && wantTunnel && !domain.tunnel) {
      if (!tunnel) {
        // Still waiting for a tunnel: nothing to change; otherwise there is no tunnel to switch to.
        if (!domain.wantsTunnel)
          return void showError("No tunnel can serve this domain", `Create a Cloudflare Tunnel on ${props.serverName} for the account that manages ${domain.hostname}.`);
      } else if ((await reroute.run(tunnel.id)) === undefined) return;
    } else if (props.isAdmin && !wantTunnel && usesTunnel) {
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
  // Tunnel domains get HTTPS from Cloudflare, and without a proxy there is nothing to secure here.
  const showTls = route === "ip" && (props.proxyKind ?? "nginx") !== "none";
  const reroute = useAction((to: string | null) => setDomainRoute(domain.id, to), {
    onSuccess: (r) => {
      if (r?.warning) toast.warning("Route updated", r.warning);
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
            {props.isAdmin && (props.tunnels.length > 0 || domain.wantsTunnel) && (
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
            {showTls && <TlsChoice props={props} hostname={domain.hostname} value={tls} onChange={setTls} certificateId={certificateId} onCertificate={setCertificateId} />}
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
  const can = useCan();
  const canManage = can("domains.manage");
  const [open, setOpen] = React.useState(false);
  const [choosingMain, setChoosingMain] = React.useState(false);
  const mainEntry = (props.entryServers?.length ?? 0) > 1 ? props.entryServers!.find((e) => e.main) : undefined;
  const [editing, setEditing] = React.useState<DomainRow | null>(null);
  const confirm = useConfirm();
  const generate = useAction(() => generateDomain(props.serviceId));
  const remove = useAction((id: string, dns: boolean) => removeDomain(id, dns));
  const toggleHttps = useAction((id: string, https: boolean) => updateDomain(id, { https, forceHttps: https }));
  const retry = useAction(retryCertificate);
  const reconnect = useAction(reconnectDomainTunnel);
  const makePrimary = useAction(setPrimaryDomain, { result: "Primary domain set. Redeploy so SERVE_PUBLIC_URL uses it." });
  const used = new Set(props.domains.map((d) => d.tunnelId));
  const starting = props.tunnels.some((t) => used.has(t.id) && (t.status === "pending" || t.status === "down"));
  // While a tunnel these domains use is coming up, ask Cloudflare every few seconds instead of waiting for the worker's check.
  React.useEffect(() => {
    if (!starting) return;
    const started = Date.now();
    let busy = false;
    const timer = setInterval(async () => {
      if (Date.now() - started > 3 * 60_000) return clearInterval(timer);
      // One check at a time, even when Cloudflare answers slowly.
      if (busy) return;
      busy = true;
      // A status change reaches the page as a live event, which refreshes it.
      await refreshTunnels().catch(() => {});
      busy = false;
    }, 4000);
    return () => clearInterval(timer);
  }, [starting]);

  return (
    <Card className="overflow-hidden">
      <CardHeader
        title="Domains"
        description={proxySubtitle(props.proxyKind)}
        actions={
          <>
            {props.canGenerate && canManage && (
              <Button size="sm" onClick={() => generate.run()} loading={generate.pending}>
                <Sparkles /> Generate
              </Button>
            )}
            <Button size="sm" variant="primary" onClick={() => setOpen(true)} disabled={!canManage} title={canManage ? undefined : cannotMessage("domains.manage")}>
              <Plus /> Add domain
            </Button>
          </>
        }
      />
      {mainEntry && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-line bg-surface-2/60 px-4 py-2.5 text-[13px] sm:px-5">
          <span className="text-muted">Visitors enter through</span>
          <span className="font-medium text-fg">{mainEntry.name}</span>
          <span className="text-xs text-faint">{entryWays(mainEntry)}</span>
          {entryProblem(mainEntry) && (
            <Tooltip content={entryProblem(mainEntry)}>
              <Badge tone="bad">Can&apos;t take visitors</Badge>
            </Tooltip>
          )}
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto"
            onClick={() => setChoosingMain(true)}
            disabled={!can("services.manage")}
            title={can("services.manage") ? undefined : cannotMessage("services.manage")}
          >
            Change
          </Button>
          <MainServerDialog serviceId={props.serviceId} servers={props.entryServers!} domains={props.entryDomains ?? []} open={choosingMain} onOpenChange={setChoosingMain} />
        </div>
      )}
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
                  <HttpsState d={d} hasAcme={props.hasAcme} undeployed={props.undeployed} proxyKind={props.proxyKind} />
                </div>
                <TunnelNotice d={d} tunnels={props.tunnels} serverName={props.serverName} />
              </div>
              <div className="flex flex-none items-center gap-2 pt-0.5">
                <DnsBadge domainId={d.id} />
                <Menu>
                  <MenuTrigger
                    className="rounded-lg p-1.5 text-muted hover:bg-hover hover:text-fg disabled:opacity-40"
                    aria-label="Domain actions"
                    disabled={!canManage}
                    title={canManage ? undefined : cannotMessage("domains.manage")}
                  >
                    <MoreHorizontal className="size-4" />
                  </MenuTrigger>
                  <MenuContent>
                    {props.isAdmin && d.wantsTunnel && !d.tunnel && (
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
                            description: d.managedRecord ? "The DNS record created in Cloudflare is deleted too." : "The domain stops routing to this service.",
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
