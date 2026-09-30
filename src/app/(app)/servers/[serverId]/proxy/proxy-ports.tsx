"use client";

import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { SwitchRow } from "@/components/ui/switch";
import { updateServer } from "@/server/actions/servers";
import { SettingsCard } from "@/app/(app)/settings/_components/settings-card";

const port = (value: string) => Number(value.replace(/\D/g, "").slice(0, 5)) || 0;

/**
 * Host ports the proxy listens on, for example to run it behind another proxy on the same machine.
 * Off (0/0): the proxy takes no port and only serves Cloudflare Tunnels, the default for servers
 * without a public IP.
 */
export function ProxyPortsCard({ serverId, isLocal, ports }: { serverId: string; isLocal: boolean; ports: { proxyHttpPort: number; proxyHttpsPort: number } }) {
  const off = ports.proxyHttpPort === 0 && ports.proxyHttpsPort === 0;
  return (
    <SettingsCard
      title="Proxy ports"
      description={`Host ports the proxy listens on. Saving recreates the proxy on the new ports; if a port is taken, nothing changes.${isLocal ? " This overrides SERVE_PROXY_HTTP_PORT and SERVE_PROXY_HTTPS_PORT." : ""}`}
      initial={{ open: !off, http: off ? "80" : String(ports.proxyHttpPort), https: off ? "443" : String(ports.proxyHttpsPort) }}
      onSave={(v) => updateServer(serverId, v.open ? { proxyHttpPort: port(v.http), proxyHttpsPort: port(v.https) } : { proxyHttpPort: 0, proxyHttpsPort: 0 })}
    >
      {(v, set) => (
        <>
          <SwitchRow
            title="Answer on this machine's ports"
            description={
              v.open
                ? "Visitors reach apps through these ports on the server."
                : "The proxy takes no port on the machine. Apps are reached only through Cloudflare Tunnels, like on a machine without a public IP."
            }
            checked={v.open}
            onCheckedChange={set("open")}
          />
          {v.open && (
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
        </>
      )}
    </SettingsCard>
  );
}
