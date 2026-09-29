"use client";

import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { SwitchRow } from "@/components/ui/switch";
import { DnsCheck } from "@/components/dns-check";
import { SettingsCard } from "../_components/settings-card";

export function DashboardSettings({
  serverIp,
  dashboard,
  acme,
}: {
  serverIp: string | null;
  dashboard: { dashboardDomain: string; dashboardHttps: boolean };
  acme: { acmeEmail: string; acmeStaging: boolean };
}) {
  return (
    <>
      <SettingsCard title="Dashboard domain" description="Serve this dashboard through the proxy of the server Serve runs on." initial={dashboard}>
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

      <SettingsCard title="Let's Encrypt" description="Free certificates for every server, renewed automatically." initial={acme}>
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
