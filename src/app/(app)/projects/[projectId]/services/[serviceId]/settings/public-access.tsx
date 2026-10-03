"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Globe, Lock, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader, CopyField } from "@/components/ui/misc";
import { Field } from "@/components/ui/field";
import { Input, Textarea } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { SecretField } from "@/components/ui/secret-field";
import { useAction } from "@/hooks/use-action";
import { applyDatabaseChanges, updateService } from "@/server/actions/services";
import { setAddonAccess } from "@/server/actions/database-access";
import { inRanges, normalizeTrustedRanges } from "@/lib/trusted-proxies";
import type { DatabaseAccessView } from "@/server/databases/access-view";
import { DatabaseDomainCard } from "../database-domain-card";

/** A newline or comma separated list of addresses, as typed and as the server will store it. */
function useAllowList(text: string) {
  const list = text
    .split(/[\s,]+/)
    .map((a) => a.trim())
    .filter(Boolean);
  const parsed = normalizeTrustedRanges(list, { anyWidth: true });
  return { list, error: "error" in parsed ? parsed.error : undefined, normalized: "ranges" in parsed ? parsed.ranges : list };
}

function AllowField({ value, onChange, viewerIp, disabled }: { value: string; onChange: (v: string) => void; viewerIp: string | null; disabled?: boolean }) {
  const allow = useAllowList(value);
  return (
    <Field
      label="Allowed IPs"
      error={allow.error}
      description={
        allow.list.length
          ? "Only these addresses can connect. The server's firewall drops everyone else, even past ufw."
          : "Empty: anyone can connect, with the password. Add addresses or ranges (203.0.113.7, 10.0.0.0/8) to let only them in."
      }
    >
      <Textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={3}
        spellCheck={false}
        placeholder={"203.0.113.7\n198.51.100.0/24"}
        className="font-mono text-[12.5px]"
        disabled={disabled}
      />
      {viewerIp && !inRanges(viewerIp, allow.normalized) && !disabled && (
        <Button type="button" variant="ghost" size="sm" className="mt-1.5 self-start" onClick={() => onChange((value.trim() ? `${value.trim()}\n` : "") + viewerIp)}>
          <Plus /> Add my IP ({viewerIp})
        </Button>
      )}
    </Field>
  );
}

const reachableOptions = [
  { value: "127.0.0.1", label: "This machine", description: "localhost on the server only, safest" },
  { value: "0.0.0.0", label: "Everyone", description: "Any network that reaches the server" },
];

/** The database's own public port: saved, then applied with a restart. */
function DatabasePublicCard({ serviceId, view, canManage }: { serviceId: string; view: DatabaseAccessView; canManage: boolean }) {
  const d = view.database;
  const [on, setOn] = React.useState(!!d.publicPort);
  const [port, setPort] = React.useState(String(d.publicPort ?? view.engine.port + 10000));
  const [bind, setBind] = React.useState(d.publicBind);
  const [allow, setAllow] = React.useState(d.publicAllow.join("\n"));
  // Saved settings changed elsewhere (a domain opens or closes the port): the form shows them.
  const saved = `${d.publicPort}|${d.publicBind}|${d.publicAllow.join(",")}`;
  const [lastSaved, setLastSaved] = React.useState(saved);
  if (saved !== lastSaved) {
    setLastSaved(saved);
    setOn(!!d.publicPort);
    setPort(String(d.publicPort ?? view.engine.port + 10000));
    setBind(d.publicBind);
    setAllow(d.publicAllow.join("\n"));
  }
  const allowList = useAllowList(allow);
  const router = useRouter();
  const apply = useAction(
    async () => {
      const res = await updateService(serviceId, { database: { publicPort: on ? Number(port) : null, publicBind: bind, publicAllow: allowList.list } });
      if (!res.ok) return res;
      return applyDatabaseChanges(serviceId);
    },
    { onSuccess: () => router.refresh() },
  );
  const changed =
    (on ? Number(port) : null) !== d.publicPort || (on && bind !== d.publicBind) || (on && bind === "0.0.0.0" && allowList.normalized.join(",") !== d.publicAllow.join(","));
  return (
    <Card>
      <CardHeader
        title="Public port"
        description="Publish the database on a port of its server, for example to connect with a desktop client."
        actions={<Switch checked={on} onCheckedChange={setOn} disabled={!canManage} aria-label="Public port" />}
      />
      <CardBody className="flex flex-col gap-4">
        {on ? (
          <>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-[160px_minmax(0,1fr)]">
              <Field label="Port">
                <Input value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, ""))} className="font-mono" inputMode="numeric" disabled={!canManage} />
              </Field>
              <Field label="Reachable by">
                <Select value={bind} onValueChange={(b) => setBind(b as typeof bind)} disabled={!canManage} options={reachableOptions} />
              </Field>
            </div>
            {bind === "127.0.0.1" ? (
              <p className="text-[12.5px] leading-relaxed text-muted">Connect at localhost on the server, or through an SSH tunnel from your laptop.</p>
            ) : (
              <AllowField value={allow} onChange={setAllow} viewerIp={view.viewerIp} disabled={!canManage} />
            )}
            {d.publicUrl && !changed && (
              <Field label={`Public connection URL · ${d.publicAddress}`}>
                <SecretField value={d.publicUrl} hidden={view.hideSecrets} shape={d.publicUrl} />
              </Field>
            )}
          </>
        ) : (
          <p className="flex items-center gap-2 text-[13px] text-muted">
            <Lock className="size-3.5" /> Only reachable from services in this project environment.
          </p>
        )}
        {changed && (
          <div className="flex justify-end">
            <Button variant="primary" size="sm" onClick={() => apply.run()} loading={apply.pending}>
              <Globe /> Apply and restart
            </Button>
          </div>
        )}
      </CardBody>
    </Card>
  );
}

type Addon = NonNullable<DatabaseAccessView["pooler"]>;

/** Public access of the pooler or the read replicas: a port with TLS, an allowlist and a domain. */
function AddonAccessCard({
  serviceId,
  which,
  addon,
  view,
  canManage,
}: {
  serviceId: string;
  which: "pooler" | "replicas";
  addon: Addon;
  view: DatabaseAccessView;
  canManage: boolean;
}) {
  const router = useRouter();
  const [on, setOn] = React.useState(addon.open);
  const [port, setPort] = React.useState(addon.port ? String(addon.port) : "");
  const [bind, setBind] = React.useState(addon.bind);
  const [allow, setAllow] = React.useState(addon.allow.join("\n"));
  const [domain, setDomain] = React.useState(addon.domain ?? "");
  const [via, setVia] = React.useState(addon.via);
  const allowList = useAllowList(allow);
  const save = useAction(
    () =>
      setAddonAccess(serviceId, which, {
        open: on,
        port: port ? Number(port) : null,
        bind,
        allow: allowList.list,
        domain: domain.trim() || null,
        via,
      }),
    {
      result: (r) => (r.warnings.length ? r.warnings.join(" ") : on ? "Public access saved" : "Public access off"),
      onSuccess: () => router.refresh(),
    },
  );
  const changed =
    on !== addon.open ||
    (on &&
      ((port ? Number(port) : null) !== addon.port ||
        bind !== addon.bind ||
        allowList.normalized.join(",") !== addon.allow.join(",") ||
        (domain.trim() || null) !== addon.domain ||
        via !== addon.via));
  const tunnel = which === "pooler" && via === "tunnel" && !!domain.trim();
  const title = which === "pooler" ? "Connection pooler" : "Read replicas";
  return (
    <Card>
      <CardHeader
        title={title}
        description={
          which === "pooler"
            ? "Reach the pooler from outside Serve, for apps hosted elsewhere. Over its public port it speaks TLS only; apps in Serve keep the private address."
            : `Reach the replicas from outside Serve, for reporting tools. The same port opens on ${addon.servers === 1 ? "the replica's server" : `each of the ${addon.servers} replica servers`}, TLS only.`
        }
        actions={<Switch checked={on} onCheckedChange={setOn} disabled={!canManage} aria-label={`${title} public access`} />}
      />
      <CardBody className="flex flex-col gap-4">
        {on ? (
          <>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Domain" description={which === "replicas" ? "Optional. Leads to every replica server." : "Optional."}>
                <Input
                  value={domain}
                  onChange={(e) => setDomain(e.target.value)}
                  placeholder={which === "pooler" ? "pool.example.com" : "read.example.com"}
                  disabled={!canManage}
                />
              </Field>
              {which === "pooler" && view.tunnels.length > 0 && domain.trim() ? (
                <Field label="Through">
                  <Select
                    value={via}
                    onValueChange={(v) => setVia(v as typeof via)}
                    disabled={!canManage}
                    options={[
                      { value: "direct", label: "Its own port", description: "A DNS record to this server" },
                      { value: "tunnel", label: "Cloudflare Tunnel", description: "No port opened; clients run cloudflared" },
                    ]}
                  />
                </Field>
              ) : null}
            </div>
            {!tunnel && (
              <>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-[160px_minmax(0,1fr)]">
                  <Field label="Port" description="Empty: a free one.">
                    <Input value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, "").slice(0, 5))} className="font-mono" inputMode="numeric" disabled={!canManage} />
                  </Field>
                  <Field label="Reachable by">
                    <Select value={bind} onValueChange={(b) => setBind(b as typeof bind)} disabled={!canManage} options={reachableOptions} />
                  </Field>
                </div>
                {bind === "0.0.0.0" && <AllowField value={allow} onChange={setAllow} viewerIp={view.viewerIp} disabled={!canManage} />}
              </>
            )}
            {!changed && addon.url && (
              <Field label="Public connection URL">
                <SecretField value={addon.url} hidden={view.hideSecrets} shape={addon.url} />
              </Field>
            )}
            {!changed && addon.tunnelCommand && (
              <Field
                label="Connect through the tunnel"
                description="Run it on the computer you connect from (your laptop, not the server), then connect to localhost:5432. It needs cloudflared from Cloudflare."
              >
                <CopyField value={addon.tunnelCommand} />
              </Field>
            )}
            {!changed && addon.certificates.some((c) => c.status !== "active") && (
              <p className="text-xs text-muted">
                The certificate for {addon.domain} is being issued
                {addon.certificates.length > 1 ? ` on ${addon.certificates.filter((c) => c.status !== "active").length} of the servers` : ""}. Until then, Serve&apos;s own
                certificate is served.
              </p>
            )}
          </>
        ) : (
          <p className="flex items-center gap-2 text-[13px] text-muted">
            <Lock className="size-3.5" /> Only reachable from services in this project environment, at{" "}
            {which === "pooler" ? `${view.privateHost}-pooler` : `${view.privateHost}-replica`}.
          </p>
        )}
        {changed && (
          <div className="flex justify-end">
            <Button variant="primary" size="sm" onClick={() => save.run()} loading={save.pending} disabled={!canManage || !!allowList.error}>
              <Globe /> Save
            </Button>
          </div>
        )}
      </CardBody>
    </Card>
  );
}

/** Settings → Public access of a database: how it is reached from outside Serve. */
export function PublicAccess({ serviceId, view, canManage, canManageDomain }: { serviceId: string; view: DatabaseAccessView; canManage: boolean; canManageDomain: boolean }) {
  return (
    <div className="flex flex-col gap-6">
      <DatabasePublicCard serviceId={serviceId} view={view} canManage={canManage} />
      {view.domain && <DatabaseDomainCard serviceId={serviceId} info={view.domain} hideSecrets={view.hideSecrets} canManage={canManageDomain} />}
      {view.pooler && <AddonAccessCard serviceId={serviceId} which="pooler" addon={view.pooler} view={view} canManage={canManage && canManageDomain} />}
      {view.replicas && <AddonAccessCard serviceId={serviceId} which="replicas" addon={view.replicas} view={view} canManage={canManage && canManageDomain} />}
    </div>
  );
}
