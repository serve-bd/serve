"use client";

import * as React from "react";
import { Brush, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardBody, CardFooter, CardHeader, TimeAgo } from "@/components/ui/misc";
import { Field } from "@/components/ui/field";
import { Input, InputGroup } from "@/components/ui/input";
import { SwitchRow } from "@/components/ui/switch";
import { Led } from "@/components/ui/status";
import { useAction } from "@/hooks/use-action";
import { detectIp, resyncProxy, runCleanup, saveServerSettings } from "@/server/actions/server";
import { formatBytes } from "@/lib/utils";

type S = {
  instanceName: string;
  serverIp: string;
  wildcardDomain: string;
  sslipFallback: boolean;
  dashboardDomain: string;
  dashboardHttps: boolean;
  acmeEmail: string;
  acmeStaging: boolean;
  imageRetention: number;
  metricsRetentionHours: number;
  buildConcurrency: number;
  proxyMaxBodySize: string;
  allowOrganizationCreation: boolean;
};

function Section({ title, description, children, fields, values, initial }: { title: string; description?: string; children: React.ReactNode; fields: (keyof S)[]; values: S; initial: React.RefObject<S> }) {
  const dirty = fields.some((f) => values[f] !== initial.current[f]);
  const save = useAction(() => saveServerSettings(Object.fromEntries(fields.map((f) => [f, values[f]]))), {
    success: "Settings saved",
    onSuccess: () => {
      for (const f of fields) (initial.current as Record<string, unknown>)[f] = values[f];
    },
  });
  return (
    <Card>
      <form onSubmit={(e) => { e.preventDefault(); void save.run(); }}>
        <CardHeader title={title} description={description} />
        <CardBody className="flex flex-col gap-4 py-5">{children}</CardBody>
        <CardFooter className="justify-end">
          <Button type="submit" size="sm" variant="primary" disabled={!dirty} loading={save.pending}>Save</Button>
        </CardFooter>
      </form>
    </Card>
  );
}

export function ServerSettingsView({
  settings,
  status,
  organizations,
}: {
  settings: S;
  status: {
    docker: string | null;
    dockerError: string | null;
    proxy: { exists: boolean; running: boolean; image: string | null; startedAt: string | null } | null;
    nixpacks: boolean;
    hostname: string;
    platform: string;
    arch: string;
    cpus: number;
    memory: number;
    dataDir: string;
    proxyPorts: string;
  };
  organizations: { id: string; name: string; createdAt: string; members: number; isRoot: boolean }[];
}) {
  const [v, setV] = React.useState<S>(settings);
  const initial = React.useRef<S>({ ...settings });
  const set = <K extends keyof S>(k: K) => (val: S[K]) => setV((p) => ({ ...p, [k]: val }));
  const sync = useAction(resyncProxy, { success: "Proxy configuration is being rebuilt" });
  const clean = useAction(runCleanup, { success: "Cleanup started" });

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader title="Status" actions={<><Button size="sm" onClick={() => sync.run()} loading={sync.pending}><RefreshCw /> Rebuild proxy</Button><Button size="sm" onClick={() => clean.run()} loading={clean.pending}><Brush /> Clean up</Button></>} />
        <div className="grid divide-y divide-line sm:grid-cols-2 sm:divide-y-0">
          <dl className="flex flex-col divide-y divide-line">
            {[
              ["Docker", <span key="d" className="flex items-center gap-2"><Led color={status.docker ? "var(--ok)" : "var(--bad)"} />{status.docker ? `v${status.docker}` : status.dockerError}</span>],
              ["nginx proxy", <span key="p" className="flex items-center gap-2"><Led color={status.proxy?.running ? "var(--ok)" : "var(--bad)"} />{status.proxy?.running ? <>Running · <TimeAgo date={status.proxy.startedAt} /></> : "Not running"}</span>],
              ["Proxy ports", status.proxyPorts],
              ["Nixpacks", status.nixpacks ? "Installed" : "Not installed"],
            ].map(([k, val]) => (
              <div key={String(k)} className="flex items-center justify-between gap-4 px-5 py-2.5 text-[13px]"><dt className="text-muted">{k}</dt><dd className="text-right text-fg-2">{val}</dd></div>
            ))}
          </dl>
          <dl className="flex flex-col divide-y divide-line sm:border-l sm:border-line">
            {[
              ["Hostname", status.hostname],
              ["System", `${status.platform} · ${status.arch}`],
              ["Resources", `${status.cpus} CPU · ${formatBytes(status.memory, 0)}`],
              ["Data directory", <code key="dd" className="font-mono text-xs">{status.dataDir}</code>],
            ].map(([k, val]) => (
              <div key={String(k)} className="flex items-center justify-between gap-4 px-5 py-2.5 text-[13px]"><dt className="text-muted">{k}</dt><dd className="truncate text-right text-fg-2">{val}</dd></div>
            ))}
          </dl>
        </div>
      </Card>

      <Section title="General" fields={["instanceName", "serverIp"]} values={v} initial={initial}>
        <Field label="Server name"><Input value={v.instanceName} onChange={(e) => set("instanceName")(e.target.value)} /></Field>
        <Field label="Public IPv4" description="Used for DNS records and generated domains.">
          <div className="flex gap-2">
            <Input value={v.serverIp} onChange={(e) => set("serverIp")(e.target.value)} className="font-mono" placeholder="203.0.113.10" />
            <Button onClick={async () => { const r = await detectIp(); if (r.ok) set("serverIp")(r.data); }}>Detect</Button>
          </div>
        </Field>
      </Section>

      <Section title="Domains" description="How apps and the dashboard are reached." fields={["wildcardDomain", "sslipFallback", "dashboardDomain", "dashboardHttps"]} values={v} initial={initial}>
        <Field label="Wildcard domain for apps" optional description="Point *.your-domain to this server. New apps get a subdomain automatically.">
          <InputGroup prefix="*."><Input value={v.wildcardDomain} onChange={(e) => set("wildcardDomain")(e.target.value)} placeholder="apps.example.com" /></InputGroup>
        </Field>
        <SwitchRow title="Fall back to sslip.io" description="Generate app.<ip>.sslip.io domains when no wildcard domain is set." checked={v.sslipFallback} onCheckedChange={set("sslipFallback")} />
        <Field label="Dashboard domain" optional description="Serve this dashboard on a domain through the proxy.">
          <Input value={v.dashboardDomain} onChange={(e) => set("dashboardDomain")(e.target.value)} placeholder="serve.example.com" />
        </Field>
        <SwitchRow title="HTTPS for the dashboard" description="Requests a Let's Encrypt certificate for the dashboard domain." checked={v.dashboardHttps} onCheckedChange={set("dashboardHttps")} />
      </Section>

      <Section title="Let's Encrypt" fields={["acmeEmail", "acmeStaging"]} values={v} initial={initial}>
        <Field label="Account email" description="Required for automatic certificates."><Input type="email" value={v.acmeEmail} onChange={(e) => set("acmeEmail")(e.target.value)} placeholder="ops@example.com" /></Field>
        <SwitchRow title="Use staging" description="Untrusted test certificates with higher rate limits." checked={v.acmeStaging} onCheckedChange={set("acmeStaging")} />
      </Section>

      <Section title="Builds and limits" fields={["buildConcurrency", "imageRetention", "metricsRetentionHours", "proxyMaxBodySize"]} values={v} initial={initial}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Concurrent builds"><Input value={String(v.buildConcurrency)} onChange={(e) => set("buildConcurrency")(Number(e.target.value.replace(/\D/g, "")) || 1)} inputMode="numeric" /></Field>
          <Field label="Images kept per service" description="For instant rollbacks."><Input value={String(v.imageRetention)} onChange={(e) => set("imageRetention")(Number(e.target.value.replace(/\D/g, "")) || 1)} inputMode="numeric" /></Field>
          <Field label="Metrics history"><InputGroup suffix="hours"><Input value={String(v.metricsRetentionHours)} onChange={(e) => set("metricsRetentionHours")(Number(e.target.value.replace(/\D/g, "")) || 1)} inputMode="numeric" /></InputGroup></Field>
          <Field label="Max upload size" description="nginx client_max_body_size."><Input value={v.proxyMaxBodySize} onChange={(e) => set("proxyMaxBodySize")(e.target.value)} className="font-mono" /></Field>
        </div>
      </Section>

      <Section title="Organizations" description="Organizations on this server." fields={["allowOrganizationCreation"]} values={v} initial={initial}>
        <SwitchRow title="Let every user create organizations" description="When off, only Root admins can create them." checked={v.allowOrganizationCreation} onCheckedChange={set("allowOrganizationCreation")} />
        <div className="divide-y divide-line rounded-xl border border-line">
          {organizations.map((o) => (
            <div key={o.id} className="flex items-center gap-3 px-4 py-2.5 text-[13px]">
              <span className="flex-1 font-medium text-fg">{o.name}</span>
              {o.isRoot && <Badge tone="accent">Root</Badge>}
              <span className="text-muted">{o.members} member{o.members === 1 ? "" : "s"}</span>
              <span className="text-faint"><TimeAgo date={o.createdAt} /></span>
            </div>
          ))}
        </div>
      </Section>
    </div>
  );
}
