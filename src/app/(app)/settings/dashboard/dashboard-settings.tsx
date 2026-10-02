"use client";

import Link from "next/link";
import { Globe, Waypoints } from "lucide-react";
import { Field } from "@/components/ui/field";
import { Select } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { SwitchRow } from "@/components/ui/switch";
import { DnsCheck } from "@/components/dns-check";
import { certificateCovers } from "@/server/ssl/match";
import { cn } from "@/lib/utils";
import { SettingsCard } from "../_components/settings-card";
import { ConnectionCheck } from "./connection-check";

export function DashboardSettings({
  serverIp,
  dashboard,
  acme,
  tunnels,
  certificates,
}: {
  serverIp: string | null;
  dashboard: { dashboardDomain: string; dashboardHttps: boolean; dashboardCertificateId: string | null; dashboardTunnelId: string | null; dashboardWantsTunnel: boolean };
  /** Certificates of the Root organization on this server that are not Let's Encrypt ones. */
  certificates: { id: string; name: string; domains: string[] }[];
  /** Tunnels on the server Serve runs on. */
  tunnels: { id: string; label: string }[];
  acme: { acmeEmail: string; acmeStaging: boolean };
}) {
  return (
    <>
      <SettingsCard title="Dashboard domain" description="Serve this dashboard on its own domain, like any service." initial={dashboard}>
        {(v, set) => (
          <>
            <Field
              label="Domain"
              optional={!v.dashboardWantsTunnel}
              description={
                v.dashboardWantsTunnel && !v.dashboardDomain
                  ? "Enter a domain to route it through the tunnel. Without one, the tunnel choice is cleared on save."
                  : "GitHub webhooks and invite links use this address."
              }
            >
              <Input value={v.dashboardDomain} onChange={(e) => set("dashboardDomain")(e.target.value)} placeholder="serve.example.com" />
            </Field>
            {dashboard.dashboardDomain && v.dashboardDomain === dashboard.dashboardDomain && (
              <ConnectionCheck domain={dashboard.dashboardDomain} tunnel={dashboard.dashboardWantsTunnel} />
            )}
            {(tunnels.length > 0 || v.dashboardWantsTunnel) && (
              <Field label="Route traffic through">
                <div className="grid grid-cols-2 gap-1 rounded-xl bg-sunken p-1">
                  {(["ip", "tunnel"] as const).map((r) => {
                    const active = r === "tunnel" ? v.dashboardWantsTunnel : !v.dashboardWantsTunnel;
                    return (
                      <button
                        key={r}
                        type="button"
                        onClick={() => {
                          set("dashboardWantsTunnel")(r === "tunnel");
                          set("dashboardTunnelId")(r === "tunnel" ? (v.dashboardTunnelId ?? tunnels[0]?.id ?? null) : null);
                        }}
                        className={`flex h-8 items-center justify-center gap-1.5 rounded-lg text-[13px] font-medium transition-all ${active ? "bg-surface text-fg shadow-sm" : "text-muted hover:text-fg"}`}
                      >
                        {r === "tunnel" ? <Waypoints className="size-3.5 text-[#f38020]" /> : <Globe className="size-3.5" />}
                        {r === "tunnel" ? "Cloudflare Tunnel" : "Server IP"}
                      </button>
                    );
                  })}
                </div>
              </Field>
            )}
            {v.dashboardWantsTunnel && !v.dashboardTunnelId ? (
              <p className="flex gap-2.5 rounded-xl border border-warn/30 bg-warn-soft p-3.5 text-[13px] leading-relaxed text-fg-2">
                <Waypoints className="mt-0.5 size-4 flex-none text-warn" />
                <span>
                  Waiting for a tunnel. This server has no Cloudflare Tunnel right now, so the dashboard domain does not answer. Create one in{" "}
                  <Link href="/integrations/cloudflare" className="text-accent hover:underline">
                    Integrations → Cloudflare
                  </Link>{" "}
                  and the domain reconnects automatically, or switch to Server IP.
                </span>
              </p>
            ) : v.dashboardTunnelId ? (
              <>
                {tunnels.length > 1 && (
                  <Field label="Tunnel">
                    <Select value={v.dashboardTunnelId} onValueChange={set("dashboardTunnelId")} options={tunnels.map((t) => ({ value: t.id, label: t.label }))} />
                  </Field>
                )}
                <p className="flex gap-2.5 rounded-xl border border-line bg-surface-2 p-3.5 text-[13px] leading-relaxed text-fg-2">
                  <Waypoints className="mt-0.5 size-4 flex-none text-[#f38020]" />
                  The domain points at the tunnel when you save. Cloudflare serves it over HTTPS, so no public IP, open port or certificate is needed.
                </p>
              </>
            ) : (
              <>
                {/* The Connection card checks the saved domain; this covers a domain being typed. */}
                {v.dashboardDomain !== dashboard.dashboardDomain && <DnsCheck host={v.dashboardDomain} serverIp={serverIp} />}
                <TlsChoice
                  domain={v.dashboardDomain}
                  certificates={certificates}
                  https={v.dashboardHttps}
                  certificateId={v.dashboardCertificateId}
                  onChange={(https, id) => {
                    set("dashboardHttps")(https);
                    set("dashboardCertificateId")(id);
                  }}
                />
                {tunnels.length === 0 && (
                  <p className="text-xs text-muted">
                    No public IP? Create a Cloudflare Tunnel for this server in{" "}
                    <Link href="/integrations/cloudflare" className="text-accent hover:underline">
                      Integrations → Cloudflare
                    </Link>{" "}
                    and route the dashboard through it.
                  </p>
                )}
              </>
            )}
          </>
        )}
      </SettingsCard>

      <SettingsCard title="Let's Encrypt" description="Free certificates for every server, renewed automatically." initial={acme}>
        {(v, set) => (
          <>
            <Field label="Account email" description="Let's Encrypt sends expiry warnings here. Required for automatic certificates.">
              <Input type="email" value={v.acmeEmail} onChange={(e) => set("acmeEmail")(e.target.value)} placeholder="ops@example.com" />
            </Field>
            <SwitchRow
              title="Use staging"
              description="Untrusted test certificates with much higher rate limits. Turn off for production."
              checked={v.acmeStaging}
              onCheckedChange={set("acmeStaging")}
            />
          </>
        )}
      </SettingsCard>
    </>
  );
}

/** How the dashboard domain is secured, like an app's domain: a free certificate, one of yours, or plain HTTP. */
function TlsChoice({
  domain,
  certificates,
  https,
  certificateId,
  onChange,
}: {
  domain: string;
  certificates: { id: string; name: string; domains: string[] }[];
  https: boolean;
  certificateId: string | null;
  onChange: (https: boolean, certificateId: string | null) => void;
}) {
  const own = domain ? certificates.filter((c) => certificateCovers(c.domains, domain)) : [];
  const value = !https ? "none" : certificateId ? "custom" : "auto";
  const options = [
    { id: "auto", title: "HTTPS, free certificate", body: "Get a free Let's Encrypt certificate and redirect HTTP to HTTPS." },
    ...(own.length || value === "custom" ? [{ id: "custom", title: "HTTPS, my certificate", body: "Use a certificate you uploaded in Certificates." }] : []),
    { id: "none", title: "HTTP only", body: "No certificate. For when your own proxy, load balancer or CDN in front handles HTTPS." },
  ] as const;
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
            onClick={() => onChange(o.id !== "none", o.id === "custom" ? (certificateId ?? own[0]?.id ?? null) : null)}
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
      {value === "custom" && own.length > 0 && (
        <Select
          value={certificateId ?? own[0].id}
          onValueChange={(id) => onChange(true, id)}
          options={own.map((c) => ({ value: c.id, label: c.name, description: c.domains.join(", ") }))}
        />
      )}
      {value === "custom" && !own.length && (
        <p className="text-xs leading-relaxed text-bad">The chosen certificate does not cover {domain || "this domain"}. Pick another option.</p>
      )}
    </div>
  );
}
