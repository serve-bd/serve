"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Globe, Lock, Plus, RefreshCw, TriangleAlert } from "lucide-react";
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
import { retryDatabaseCertificate, saveDatabaseDomain } from "@/server/actions/database-domains";
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

/** Who can connect: one choice for what is two settings on the server (the bind address and the allowlist). */
type Who = "anyone" | "some" | "local";

function whoOf(bind: string, allow: string[]): Who {
  return bind === "127.0.0.1" ? "local" : allow.length ? "some" : "anyone";
}

/** The choice, and the addresses when only some can connect. */
function useWho(bind: string, allow: string[]) {
  const [who, setWho] = React.useState<Who>(whoOf(bind, allow));
  const [text, setText] = React.useState(allow.join("\n"));
  const list = useAllowList(text);
  const empty = who === "some" && !list.list.length;
  return {
    who,
    setWho,
    text,
    setText,
    bind: who === "local" ? ("127.0.0.1" as const) : ("0.0.0.0" as const),
    // Only what the choice keeps: addresses typed and then "Anyone" picked are not saved.
    allow: who === "some" ? list.list : [],
    normalized: who === "some" ? list.normalized : [],
    error: who === "some" ? (list.error ?? (empty ? "Add at least one address." : undefined)) : undefined,
  };
}

function WhoField({ state, viewerIp, disabled, localOk }: { state: ReturnType<typeof useWho>; viewerIp: string | null; disabled?: boolean; localOk: boolean }) {
  const options = [
    { value: "anyone", label: "Anyone with the password" },
    { value: "some", label: "Only some IP addresses" },
    ...(localOk || state.who === "local" ? [{ value: "local", label: "Only this server", description: "localhost, or an SSH tunnel" }] : []),
  ];
  return (
    <div className="flex flex-col gap-3">
      <Field label="Who can connect">
        <Select value={state.who} onValueChange={(w) => state.setWho(w as Who)} disabled={disabled} options={options} />
      </Field>
      {state.who === "some" && (
        <Field error={state.error} description="One per line. Ranges work too, like 10.0.0.0/8.">
          <Textarea
            value={state.text}
            onChange={(e) => state.setText(e.target.value)}
            rows={2}
            spellCheck={false}
            placeholder={"203.0.113.7\n198.51.100.0/24"}
            className="font-mono text-[12.5px]"
            disabled={disabled}
          />
          {viewerIp && !inRanges(viewerIp, state.normalized) && !disabled && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="mt-1.5 self-start"
              onClick={() => state.setText((state.text.trim() ? `${state.text.trim()}\n` : "") + viewerIp)}
            >
              <Plus /> Add my IP ({viewerIp})
            </Button>
          )}
        </Field>
      )}
    </div>
  );
}

type Addon = NonNullable<DatabaseAccessView["pooler"]>;

/** The domain's certificate: across replica servers, the worst one counts. */
function CertBadge({ certificates }: { certificates: { status: string }[] }) {
  if (!certificates.length) return null;
  const failed = certificates.filter((c) => c.status === "failed").length;
  const active = certificates.filter((c) => c.status === "active").length;
  const many = certificates.length > 1;
  const [tone, text] =
    failed > 0
      ? (["bg-bad/10 text-bad", many ? `Certificate failed on ${failed} of ${certificates.length}` : "Certificate failed"] as const)
      : active === certificates.length
        ? (["bg-ok/10 text-ok", many ? `Certificates active on all ${certificates.length}` : "Certificate active"] as const)
        : (["bg-hover text-muted", many ? `Getting certificates (${active} of ${certificates.length})` : "Getting a certificate…"] as const);
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${tone}`}>
      <Lock className="size-3" />
      {text}
    </span>
  );
}

function Warning({ children }: { children: React.ReactNode }) {
  return (
    <p className="flex items-start gap-2 rounded-xl bg-warn-soft px-3.5 py-2.5 text-[12.5px] leading-relaxed text-fg-2">
      <TriangleAlert className="mt-0.5 size-3.5 flex-none text-warn" />
      <span>{children}</span>
    </p>
  );
}

function CertFailed({ error, onRetry, pending, disabled }: { error?: string | null; onRetry: () => void; pending: boolean; disabled?: boolean }) {
  return (
    <div className="flex items-start gap-2 text-[12.5px] leading-relaxed text-bad">
      <TriangleAlert className="mt-0.5 size-3.5 flex-none" />
      <span className="min-w-0 flex-1">
        Certificate failed{error ? `: ${error.split("\n")[0].slice(0, 160)}` : "."} Serve tries again by itself once the domain points at the server.
      </span>
      <Button type="button" size="sm" variant="ghost" className="-my-1 flex-none" disabled={disabled} loading={pending} onClick={onRetry}>
        <RefreshCw /> Retry
      </Button>
    </div>
  );
}

/** The shape every card on the page shares: a switch, the domain and port on one row, who can connect, the URL. */
function AccessCard({
  title,
  description,
  badge,
  on,
  setOn,
  disabled,
  offText,
  footer,
  children,
}: {
  title: string;
  description: string;
  badge?: React.ReactNode;
  on: boolean;
  setOn: (on: boolean) => void;
  disabled: boolean;
  offText: string;
  /** The save button: also there with the switch off, to save turning it off. */
  footer?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader
        title={title}
        description={description}
        actions={
          <div className="flex items-center gap-3">
            {on && badge}
            <Switch checked={on} onCheckedChange={setOn} disabled={disabled} aria-label={`${title} public access`} />
          </div>
        }
      />
      <CardBody className="flex flex-col gap-4">
        {on ? (
          children
        ) : (
          <p className="flex items-center gap-2 text-[13px] text-muted">
            <Lock className="size-3.5" /> {offText}
          </p>
        )}
        {footer}
      </CardBody>
    </Card>
  );
}

function PortInput({
  value,
  onChange,
  locked,
  placeholder,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  locked: boolean;
  placeholder?: string;
  disabled?: boolean;
}) {
  return (
    <Field label="Port" className="sm:w-36">
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value.replace(/\D/g, "").slice(0, 5))}
        placeholder={placeholder}
        className="font-mono"
        inputMode="numeric"
        // Set once, it stays: clients and firewalls point at it.
        readOnly={locked}
        title={locked ? "The port stays once set. Turn public access off and on again for a new one." : undefined}
        disabled={disabled}
      />
    </Field>
  );
}

/** The database itself: its public port and its domain, saved together and applied with one restart. */
function DatabaseCard({ serviceId, view, canManage, canManageDomain }: { serviceId: string; view: DatabaseAccessView; canManage: boolean; canManageDomain: boolean }) {
  const d = view.database;
  const info = view.domain;
  // A domain set up through a Cloudflare Tunnel (no longer offered) keeps its own card below.
  const legacy = !!info?.hostname && info.via === "tunnel";
  const domainOk = !!info && info.directSupported && !legacy;
  const noPublicIp = !!info && !info.publicIp;
  const savedDomain = domainOk ? (info.hostname ?? "") : "";
  const [on, setOn] = React.useState(!!d.publicPort);
  const [port, setPort] = React.useState(String(d.publicPort ?? view.engine.port + 10000));
  const [domain, setDomain] = React.useState(savedDomain);
  const who = useWho(d.publicBind, d.publicAllow);
  const router = useRouter();

  const dom = on && domainOk ? domain.trim().toLowerCase() || null : null;
  const bind = dom ? "0.0.0.0" : who.bind;
  const portChanged =
    (on ? Number(port) : null) !== d.publicPort || (on && bind !== d.publicBind) || (on && bind === "0.0.0.0" && who.normalized.join(",") !== d.publicAllow.join(","));
  const domainChanged = domainOk && (dom !== (info.hostname ?? null) || (!!dom && info.unreachable));
  const changed = portChanged || domainChanged;

  const save = useAction(
    async () => {
      const warnings: string[] = [];
      if (portChanged) {
        const res = await updateService(serviceId, { database: { publicPort: on ? Number(port) : null, publicBind: bind, publicAllow: who.allow } });
        if (!res.ok) return res;
      }
      if (domainChanged) {
        const res = await saveDatabaseDomain(serviceId, dom, "direct");
        if (!res.ok) return res;
        warnings.push(...res.data.warnings);
      }
      // Taking the domain off restarts the database already; otherwise the new port needs one.
      if (portChanged && !(domainChanged && !dom)) {
        const res = await applyDatabaseChanges(serviceId);
        if (!res.ok) return res;
      }
      return { ok: true as const, data: { warnings } };
    },
    { result: (r) => (r.warnings.length ? r.warnings.join(" ") : "Saved. The database restarts with it."), onSuccess: () => router.refresh() },
  );
  const retry = useAction(() => retryDatabaseCertificate(serviceId), { result: () => "Asking for the certificate again", onSuccess: () => router.refresh() });

  const cert = info?.certificate;
  const url = !changed ? (domainOk && info.hostname && info.url ? info.url : d.publicUrl) : null;
  return (
    <AccessCard
      title="Public port"
      description="Connect from outside Serve, for example with a desktop client."
      badge={domainOk && info.hostname && d.publicPort ? <CertBadge certificates={[{ status: cert?.status ?? "missing" }]} /> : undefined}
      on={on}
      setOn={setOn}
      disabled={!canManage}
      offText="Off. Only services in this project environment can connect."
      footer={
        changed && (
          <div className="flex justify-end">
            <Button variant="primary" size="sm" onClick={() => save.run()} loading={save.pending} disabled={!canManage || (on && !!who.error)}>
              <Globe /> Save and restart
            </Button>
          </div>
        )
      }
    >
      <div className="flex flex-col gap-4 sm:flex-row">
        {domainOk && (
          <Field
            label="Domain"
            optional
            className="min-w-0 flex-1"
            description={noPublicIp && !info.hostname ? "This server has no public IP, so a domain cannot reach it." : undefined}
          >
            <Input
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              placeholder="db.example.com"
              spellCheck={false}
              disabled={!canManageDomain || (noPublicIp && !info.hostname)}
            />
          </Field>
        )}
        <PortInput value={port} onChange={setPort} locked={!!d.publicPort} disabled={!canManage} />
      </div>
      <WhoField state={who} viewerIp={view.viewerIp} disabled={!canManage} localOk={!dom} />
      {!changed && domainOk && info.hostname && (
        <>
          {noPublicIp && <Warning>This server has no public IP, so {info.hostname} cannot reach the database from outside.</Warning>}
          {cert?.status === "failed" && <CertFailed error={cert.error} onRetry={() => retry.run()} pending={retry.pending} disabled={!canManageDomain} />}
        </>
      )}
      {domainOk && info.hostname && info.unreachable && <Warning>The domain does not answer right now. Save to open its port again.</Warning>}
      {url && (
        <Field label="Connection URL" description={domainOk && info.hostname && cert?.status !== "active" ? "Works once the certificate is active." : undefined}>
          <SecretField value={url} hidden={view.hideSecrets} shape={url} />
        </Field>
      )}
    </AccessCard>
  );
}

/** Public access of the pooler or the read replicas: a port with TLS, who can connect and a domain. */
function AddonCard({ serviceId, which, addon, view, canManage }: { serviceId: string; which: "pooler" | "replicas"; addon: Addon; view: DatabaseAccessView; canManage: boolean }) {
  const router = useRouter();
  const [on, setOn] = React.useState(addon.open);
  const [port, setPort] = React.useState(addon.port ? String(addon.port) : "");
  const [domain, setDomain] = React.useState(addon.domain ?? "");
  const who = useWho(addon.bind, addon.allow);
  const dom = domain.trim() || null;
  const bind = dom ? "0.0.0.0" : who.bind;
  const save = useAction(() => setAddonAccess(serviceId, which, { open: on, port: port ? Number(port) : null, bind, allow: who.allow, domain: dom, via: "direct" }), {
    result: (r) => (r.warnings.length ? r.warnings.join(" ") : on ? "Public access saved" : "Public access off"),
    onSuccess: () => router.refresh(),
  });
  const retry = useAction(() => retryDatabaseCertificate(serviceId, which), { result: () => "Asking for the certificate again", onSuccess: () => router.refresh() });
  const changed =
    on !== addon.open || (on && ((port ? Number(port) : null) !== addon.port || bind !== addon.bind || who.normalized.join(",") !== addon.allow.join(",") || dom !== addon.domain));
  const pooler = which === "pooler";
  return (
    <AccessCard
      title={pooler ? "Connection pooler" : "Read replicas"}
      description={
        pooler
          ? "For apps hosted outside Serve. TLS only."
          : `For reporting tools outside Serve. Opens on ${addon.servers === 1 ? "the replica's server" : `each of the ${addon.servers} replica servers`}. TLS only.`
      }
      badge={addon.open && addon.domain ? <CertBadge certificates={addon.certificates} /> : undefined}
      on={on}
      setOn={setOn}
      disabled={!canManage}
      offText={`Off. Only services in this project environment can connect, at ${pooler ? `${view.privateHost}-pooler` : `${view.privateHost}-replica`}.`}
      footer={
        changed && (
          <div className="flex justify-end">
            <Button variant="primary" size="sm" onClick={() => save.run()} loading={save.pending} disabled={!canManage || (on && !!who.error)}>
              <Globe /> Save
            </Button>
          </div>
        )
      }
    >
      <div className="flex flex-col gap-4 sm:flex-row">
        <Field label="Domain" optional className="min-w-0 flex-1" description={pooler ? undefined : "Leads to every replica server."}>
          <Input
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
            placeholder={pooler ? "pool.example.com" : "read.example.com"}
            spellCheck={false}
            disabled={!canManage}
          />
        </Field>
        <PortInput value={port} onChange={setPort} locked={!!addon.port} placeholder="Auto detect" disabled={!canManage} />
      </div>
      <WhoField state={who} viewerIp={view.viewerIp} disabled={!canManage} localOk={!dom} />
      {!changed &&
        addon.unreachable.map((r) => (
          <Warning key={`${r.id}-${r.server}`}>
            {addon.domain} does not reach {r.id ? `replica ${r.id} (${r.server})` : `the pooler (${r.server})`}:{" "}
            {r.reason === "no-ip"
              ? "its server has no public IP."
              : `port ${addon.port} does not answer from the internet there. Open it in the router or firewall in front of the server, then save again.`}
            {r.id ? " Apps in Serve still read from it over the private network." : ""}
          </Warning>
        ))}
      {!changed && addon.certificates.some((c) => c.status === "failed") && <CertFailed onRetry={() => retry.run()} pending={retry.pending} disabled={!canManage} />}
      {!changed && addon.url && (
        <Field label="Connection URL">
          <SecretField value={addon.url} hidden={view.hideSecrets} shape={addon.url} />
        </Field>
      )}
      {!changed && addon.tunnelCommand && (
        <Field label="Connect through the tunnel" description="Run it on the computer you connect from, then connect to localhost:5432. It needs cloudflared.">
          <CopyField value={addon.tunnelCommand} />
        </Field>
      )}
    </AccessCard>
  );
}

/** Settings → Public access of a database: how it is reached from outside Serve. */
export function PublicAccess({ serviceId, view, canManage, canManageDomain }: { serviceId: string; view: DatabaseAccessView; canManage: boolean; canManageDomain: boolean }) {
  const legacy = !!view.domain?.hostname && view.domain.via === "tunnel";
  return (
    <div className="flex flex-col gap-6">
      {/* Keyed by what is saved: after a save (or a change elsewhere) the card shows the saved values. */}
      <DatabaseCard
        key={JSON.stringify([view.database.publicPort, view.database.publicBind, view.database.publicAllow, view.domain?.hostname])}
        serviceId={serviceId}
        view={view}
        canManage={canManage}
        canManageDomain={canManageDomain}
      />
      {legacy && view.domain && <DatabaseDomainCard serviceId={serviceId} info={view.domain} hideSecrets={view.hideSecrets} canManage={canManageDomain} />}
      {view.pooler && <AddonCard key={JSON.stringify(view.pooler)} serviceId={serviceId} which="pooler" addon={view.pooler} view={view} canManage={canManage && canManageDomain} />}
      {view.replicas && (
        <AddonCard key={JSON.stringify(view.replicas)} serviceId={serviceId} which="replicas" addon={view.replicas} view={view} canManage={canManage && canManageDomain} />
      )}
    </div>
  );
}
