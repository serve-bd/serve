"use client";

import * as React from "react";
import { CheckCircle2, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input, InputGroup } from "@/components/ui/input";
import { SwitchRow } from "@/components/ui/switch";
import { checkDns } from "@/server/actions/server";
import { SettingsCard } from "../_components/settings-card";

function DnsCheck({ host, serverIp }: { host: string; serverIp: string | null }) {
  const [result, setResult] = React.useState<{ host: string; records: string[]; pointsHere: boolean } | null>(null);
  const [pending, setPending] = React.useState(false);
  if (!host) return null;
  const current = result?.host === host ? result : null;
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <Button
        size="xs"
        loading={pending}
        onClick={async () => {
          setPending(true);
          const r = await checkDns(host);
          setPending(false);
          if (r.ok) setResult({ host, ...r.data });
        }}
      >
        Check DNS
      </Button>
      {current &&
        (current.pointsHere ? (
          <span className="flex items-center gap-1 text-ok">
            <CheckCircle2 className="size-3.5" /> Points to this server
          </span>
        ) : (
          <span className="flex items-center gap-1 text-warn">
            <XCircle className="size-3.5" />
            {current.records.length ? `Points to ${current.records.join(", ")}` : "No A record found"}
            {serverIp ? `, expected ${serverIp}` : ""}
          </span>
        ))}
    </div>
  );
}

export function DomainSettings({
  serverIp,
  domains,
  acme,
}: {
  serverIp: string | null;
  domains: { wildcardDomain: string; sslipFallback: boolean; dashboardDomain: string; dashboardHttps: boolean };
  acme: { acmeEmail: string; acmeStaging: boolean };
}) {
  return (
    <>
      <SettingsCard title="App domains" description="Addresses new services get automatically." initial={{ wildcardDomain: domains.wildcardDomain, sslipFallback: domains.sslipFallback }}>
        {(v, set) => (
          <>
            <Field label="Wildcard domain" optional description={<>Point <code className="font-mono">*.{v.wildcardDomain || "apps.example.com"}</code> to this server. New services get a subdomain.</>}>
              <InputGroup prefix="*.">
                <Input value={v.wildcardDomain} onChange={(e) => set("wildcardDomain")(e.target.value)} placeholder="apps.example.com" />
              </InputGroup>
            </Field>
            {v.wildcardDomain && <DnsCheck host={`serve-check.${v.wildcardDomain}`} serverIp={serverIp} />}
            <SwitchRow
              title="Fall back to sslip.io"
              description={<>Without a wildcard domain, services get <code className="font-mono">name.{serverIp ?? "<ip>"}.sslip.io</code>.</>}
              checked={v.sslipFallback}
              onCheckedChange={set("sslipFallback")}
            />
          </>
        )}
      </SettingsCard>

      <SettingsCard title="Dashboard domain" description="Serve this dashboard through the proxy on its own domain." initial={{ dashboardDomain: domains.dashboardDomain, dashboardHttps: domains.dashboardHttps }}>
        {(v, set) => (
          <>
            <Field label="Domain" optional description="GitHub webhooks and invite links use this address.">
              <Input value={v.dashboardDomain} onChange={(e) => set("dashboardDomain")(e.target.value)} placeholder="serve.example.com" />
            </Field>
            <DnsCheck host={v.dashboardDomain} serverIp={serverIp} />
            <SwitchRow title="HTTPS" description="Request a Let's Encrypt certificate for the dashboard domain." checked={v.dashboardHttps} onCheckedChange={set("dashboardHttps")} />
          </>
        )}
      </SettingsCard>

      <SettingsCard title="Let's Encrypt" description="Free certificates, renewed automatically." initial={acme}>
        {(v, set) => (
          <>
            <Field label="Account email" description="Let's Encrypt sends expiry warnings here. Required for automatic certificates.">
              <Input type="email" value={v.acmeEmail} onChange={(e) => set("acmeEmail")(e.target.value)} placeholder="ops@example.com" />
            </Field>
            <SwitchRow title="Use staging" description="Untrusted test certificates with much higher rate limits. Turn off for production." checked={v.acmeStaging} onCheckedChange={set("acmeStaging")} />
          </>
        )}
      </SettingsCard>
    </>
  );
}
