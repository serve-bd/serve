"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input, InputGroup } from "@/components/ui/input";
import { SwitchRow } from "@/components/ui/switch";
import { DnsCheck } from "@/components/dns-check";
import { detectIp } from "@/server/actions/server";
import { updateServer } from "@/server/actions/servers";
import { SettingsCard } from "@/app/(app)/settings/_components/settings-card";
import { ProductName } from "@/components/brand";

const port = (value: string) => Number(value.replace(/\D/g, "").slice(0, 5)) || 0;

export function DomainSettings({
  serverId,
  isLocal,
  host,
  addressing,
  ports,
}: {
  serverId: string;
  isLocal: boolean;
  host: string;
  addressing: { publicIp: string; wildcardDomain: string; sslipFallback: boolean };
  ports: { proxyHttpPort: number; proxyHttpsPort: number };
}) {
  const [detecting, setDetecting] = React.useState(false);
  const ip = addressing.publicIp || null;
  return (
    <>
      <SettingsCard
        title="Addressing"
        description="How domains reach this server."
        initial={addressing}
        onSave={(v) => updateServer(serverId, { publicIp: v.publicIp || null, wildcardDomain: v.wildcardDomain || null, sslipFallback: v.sslipFallback })}
      >
        {(v, set) => (
          <>
            <Field
              label="Public IPv4"
              description={
                <>
                  Used for DNS records <ProductName /> creates and for sslip.io domains.
                </>
              }
            >
              <div className="flex gap-2 sm:max-w-sm">
                <Input value={v.publicIp} onChange={(e) => set("publicIp")(e.target.value)} className="font-mono" placeholder={isLocal ? "203.0.113.10" : host} />
                {isLocal ? (
                  <Button
                    loading={detecting}
                    onClick={async () => {
                      setDetecting(true);
                      const r = await detectIp();
                      setDetecting(false);
                      if (r.ok) set("publicIp")(r.data);
                    }}
                  >
                    Detect
                  </Button>
                ) : (
                  /^\d{1,3}(\.\d{1,3}){3}$/.test(host) && (
                    <Button onClick={() => set("publicIp")(host)} disabled={v.publicIp === host}>
                      Use {host}
                    </Button>
                  )
                )}
              </div>
            </Field>
            <Field
              label="Wildcard domain"
              optional
              description={
                <>
                  Point <code className="font-mono">*.{v.wildcardDomain || "apps.example.com"}</code> to this server. New services here get a subdomain.
                </>
              }
            >
              <InputGroup prefix="*.">
                <Input value={v.wildcardDomain} onChange={(e) => set("wildcardDomain")(e.target.value)} placeholder="apps.example.com" />
              </InputGroup>
            </Field>
            {v.wildcardDomain && <DnsCheck host={`serve-check.${v.wildcardDomain}`} serverIp={v.publicIp || ip} />}
            <SwitchRow
              title="Fall back to sslip.io"
              description={
                <>
                  Without a wildcard domain, services get <code className="font-mono">name.{v.publicIp || "<ip>"}.sslip.io</code>.
                </>
              }
              checked={v.sslipFallback}
              onCheckedChange={set("sslipFallback")}
            />
          </>
        )}
      </SettingsCard>

      {
        <SettingsCard
          title="Proxy ports"
          description={`Host ports the proxy listens on. Saving recreates the proxy on the new ports; if a port is taken, nothing changes.${isLocal ? " This overrides SERVE_PROXY_HTTP_PORT and SERVE_PROXY_HTTPS_PORT." : ""}`}
          initial={{ http: String(ports.proxyHttpPort), https: String(ports.proxyHttpsPort) }}
          onSave={(v) => updateServer(serverId, { proxyHttpPort: port(v.http), proxyHttpsPort: port(v.https) })}
        >
          {(v, set) => (
            <>
              <div className="grid grid-cols-2 gap-4 sm:max-w-sm">
                <Field label="HTTP" error={v.http && v.http === v.https ? "Use different ports" : undefined}>
                  <Input value={v.http} onChange={(e) => set("http")(e.target.value.replace(/\D/g, "").slice(0, 5))} inputMode="numeric" className="font-mono" />
                </Field>
                <Field label="HTTPS">
                  <Input value={v.https} onChange={(e) => set("https")(e.target.value.replace(/\D/g, "").slice(0, 5))} inputMode="numeric" className="font-mono" />
                </Field>
              </div>
              {(v.http !== "80" || v.https !== "443") && (
                <p className="text-xs leading-relaxed text-warn">
                  Let&apos;s Encrypt only checks ports 80 and 443. With other ports, HTTPS certificates need the Cloudflare DNS check or a Cloudflare Tunnel.
                </p>
              )}
            </>
          )}
        </SettingsCard>
      }
    </>
  );
}
