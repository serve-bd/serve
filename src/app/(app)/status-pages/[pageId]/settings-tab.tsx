"use client";

import * as React from "react";
import { CircleCheck, CircleX, Eye, Globe, Lock, Trash2, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm";
import { Field } from "@/components/ui/field";
import { Input, InputGroup } from "@/components/ui/input";
import { Card, CardHeader, CopyField } from "@/components/ui/misc";
import { SwitchRow } from "@/components/ui/switch";
import { useAction } from "@/hooks/use-action";
import { useRouter } from "@/hooks/use-router";
import { checkStatusDomain, deleteStatusPage, saveStatusPage, setStatusDomain, setStatusVisibility } from "@/server/actions/status-pages";
import type { EditorData } from "@/server/status-pages/admin";
import type { StatusVisibility } from "@/lib/status-page";
import { cn } from "@/lib/utils";

export function SettingsTab({ data, canManage }: { data: EditorData; canManage: boolean }) {
  return (
    <div className="flex max-w-3xl flex-col gap-5">
      <NameCard data={data} canManage={canManage} />
      <AccessCard data={data} canManage={canManage} />
      <DomainCard data={data} canManage={canManage} />
      <EmbedCard data={data} />
      {canManage && <DeleteCard data={data} />}
    </div>
  );
}

function NameCard({ data, canManage }: { data: EditorData; canManage: boolean }) {
  const [name, setName] = React.useState(data.page.name);
  const [slug, setSlug] = React.useState(data.page.slug);
  React.useEffect(() => {
    setName(data.page.name);
    setSlug(data.page.slug);
  }, [data.page.name, data.page.slug]);
  const { logo: _l, logoDark: _d, ...design } = data.design;
  const save = useAction(() => saveStatusPage(data.page.id, { name, slug, design }));
  const dirty = name !== data.page.name || slug !== data.page.slug;
  return (
    <Card>
      <CardHeader title="Name and address" />
      <form
        className="flex flex-col gap-4 px-5 py-4"
        onSubmit={(e) => {
          e.preventDefault();
          void save.run();
        }}
      >
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} disabled={!canManage} />
        </Field>
        <Field
          label="Address"
          description={data.page.domain ? `Also at /status/${data.page.slug} on the dashboard's domain.` : "Give it its own domain below to drop the /status part."}
        >
          <InputGroup prefix={<span className="text-muted">/status/</span>}>
            <Input value={slug} onChange={(e) => setSlug(e.target.value.toLowerCase())} maxLength={48} disabled={!canManage} className="font-mono" />
          </InputGroup>
        </Field>
        {canManage && (
          <Button type="submit" size="sm" variant="primary" className="self-end" disabled={!dirty || !name.trim()} loading={save.pending}>
            Save
          </Button>
        )}
      </form>
    </Card>
  );
}

const VISIBILITY: { value: StatusVisibility; title: string; text: string; icon: React.ReactNode }[] = [
  { value: "public", title: "Public", text: "Anyone with the address sees the page.", icon: <Globe /> },
  { value: "password", title: "Password", text: "Visitors type a password once; their browser remembers it for a month.", icon: <Lock /> },
  { value: "draft", title: "Draft", text: "Only signed-in members of your organization see it.", icon: <Eye /> },
];

function AccessCard({ data, canManage }: { data: EditorData; canManage: boolean }) {
  const [visibility, setVisibility] = React.useState<StatusVisibility>(data.page.visibility);
  const [password, setPassword] = React.useState("");
  React.useEffect(() => setVisibility(data.page.visibility), [data.page.visibility]);
  const save = useAction(() => setStatusVisibility(data.page.id, { visibility, password: password || undefined }), { onSuccess: () => setPassword("") });
  const needsPassword = visibility === "password" && !data.page.hasPassword && !password;
  const dirty = visibility !== data.page.visibility || !!password;
  return (
    <Card>
      <CardHeader title="Who can see it" />
      <div className="flex flex-col gap-4 px-5 py-4">
        <div className="grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Who can see the page">
          {VISIBILITY.map((v) => (
            <button
              key={v.value}
              type="button"
              role="radio"
              aria-checked={visibility === v.value}
              disabled={!canManage}
              onClick={() => setVisibility(v.value)}
              className={cn(
                "flex flex-col gap-1 rounded-xl border p-3 text-left transition-colors [&_svg]:size-4",
                visibility === v.value ? "border-accent bg-accent-soft/50 ring-1 ring-accent" : "border-line hover:border-line-strong hover:bg-hover/50",
              )}
            >
              <span className="flex items-center gap-2 text-[13px] font-semibold text-fg">
                {v.icon} {v.title}
              </span>
              <span className="text-xs leading-relaxed text-muted">{v.text}</span>
            </button>
          ))}
        </div>
        {visibility === "password" && (
          <Field
            label={data.page.hasPassword ? "New password" : "Password"}
            optional={data.page.hasPassword}
            description={data.page.hasPassword ? "Leave it empty to keep the current one. A new one signs every visitor out." : "At least 6 characters."}
          >
            <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" disabled={!canManage} />
          </Field>
        )}
        {canManage && (
          <Button size="sm" variant="primary" className="self-end" disabled={!dirty || needsPassword} loading={save.pending} onClick={() => save.run()}>
            Save
          </Button>
        )}
      </div>
    </Card>
  );
}

function DomainCard({ data, canManage }: { data: EditorData; canManage: boolean }) {
  const [domain, setDomain] = React.useState(data.page.domain ?? "");
  const [https, setHttps] = React.useState(data.page.https);
  const [dns, setDns] = React.useState<{ status: string; records: string[]; expected: string | null } | null>(null);
  React.useEffect(() => {
    setDomain(data.page.domain ?? "");
    setHttps(data.page.https);
    setDns(null);
  }, [data.page.domain, data.page.https]);
  const save = useAction(() => setStatusDomain(data.page.id, { domain, https }));
  const check = useAction(() => checkStatusDomain(data.page.id), { refresh: false, onSuccess: setDns });
  const dirty = domain.trim().toLowerCase() !== (data.page.domain ?? "") || https !== data.page.https;
  const cert = data.domain.certificate;
  const ip = data.domain.serverIp;

  return (
    <Card>
      <CardHeader title="Own domain" description="Serve the page at an address like status.example.com. Nothing else of Serve answers there." />
      <div className="flex flex-col gap-4 px-5 py-4">
        <Field
          label="Domain"
          optional
          description={ip ? `Point an A record for it to ${ip}, the address of this dashboard's server.` : "Point an A record for it to this dashboard's server."}
        >
          <Input value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="status.example.com" className="font-mono" disabled={!canManage} />
        </Field>
        <SwitchRow
          title="HTTPS"
          description={
            data.domain.proxy === "nginx"
              ? data.domain.acme
                ? "Serve gets a Let's Encrypt certificate once the record points here."
                : "Set a Let's Encrypt email in Server settings, or add a certificate yourself in Certificates."
              : "The proxy gets the certificate itself."
          }
          checked={https}
          onCheckedChange={setHttps}
          disabled={!canManage}
        />
        {data.page.domain && (
          <div className="flex flex-col gap-2 rounded-lg border border-line bg-surface-2 px-4 py-3 text-[13px]">
            <div className="flex flex-wrap items-center gap-2">
              {dns ? <DnsResult domain={data.page.domain} dns={dns} /> : <span className="text-muted">Check that the record is in place.</span>}
              <Button size="xs" className="ml-auto" loading={check.pending} onClick={() => check.run()}>
                Check DNS
              </Button>
            </div>
            {data.page.https && data.domain.proxy === "nginx" && (
              <p className={cn("text-xs", cert?.status === "failed" ? "text-bad" : "text-muted")}>
                Certificate:{" "}
                {cert
                  ? cert.status === "active"
                    ? "active"
                    : cert.status === "failed"
                      ? `failed. ${cert.error ?? ""} Fix the DNS record, then save again.`
                      : "on its way"
                  : "none yet"}
              </p>
            )}
          </div>
        )}
        {canManage && (
          <Button size="sm" variant="primary" className="self-end" disabled={!dirty} loading={save.pending} onClick={() => save.run()}>
            Save
          </Button>
        )}
      </div>
    </Card>
  );
}

function DnsResult({ domain, dns }: { domain: string; dns: { status: string; records: string[]; expected: string | null } }) {
  if (dns.status === "ok")
    return (
      <span className="flex items-center gap-1.5 text-ok">
        <CircleCheck className="size-4" /> {domain} points here.
      </span>
    );
  // Behind the orange cloud only Cloudflare's addresses show: where it forwards is in the Cloudflare dashboard.
  if (dns.status === "proxied")
    return (
      <span className="flex items-start gap-1.5 text-warn">
        <TriangleAlert className="mt-0.5 size-4 flex-none" />
        <span>
          {domain} is behind Cloudflare's proxy, so Serve cannot see where it points. In Cloudflare, make sure its A record points to {dns.expected ?? "this server"}. Connect the
          Cloudflare account in Integrations and Serve checks it for you.
        </span>
      </span>
    );
  return (
    <span className="flex items-center gap-1.5 text-bad">
      <CircleX className="size-4 flex-none" />
      {dns.status === "missing" || !dns.records.length
        ? `${domain} has no A record yet.`
        : `${domain} points to ${dns.records.join(", ")}${dns.expected ? `, not ${dns.expected}` : ""}.`}
    </span>
  );
}

function EmbedCard({ data }: { data: EditorData }) {
  const base = data.page.domain ? data.page.url : data.page.dashboardUrl;
  const first = data.components[0];
  return (
    <Card>
      <CardHeader title="Use it elsewhere" description="Same rules as the page: a draft or a password page does not answer here." />
      <div className="flex flex-col gap-4 px-5 py-4">
        <Field label="Badge" description={first ? `Add ?component=${first.id} for one component, ?label=API to change its text.` : undefined}>
          <CopyField value={`${base}/badge`} />
        </Field>
        <Field label="Badge in Markdown">
          <CopyField value={`[![Status](${base}/badge)](${data.page.url})`} />
        </Field>
        <Field label="JSON">
          <CopyField value={`${base}/summary.json`} />
        </Field>
        <Field label="RSS">
          <CopyField value={`${base}/feed.xml`} />
        </Field>
      </div>
    </Card>
  );
}

function DeleteCard({ data }: { data: EditorData }) {
  const confirm = useConfirm();
  const router = useRouter();
  const remove = useAction(() => deleteStatusPage(data.page.id), { refresh: false, onSuccess: () => router.push("/status-pages") });
  return (
    <Card>
      <CardHeader title="Delete page" description="The address stops working. Services and their checks stay." />
      <div className="px-5 py-4">
        <Button
          size="sm"
          variant="danger-ghost"
          loading={remove.pending}
          onClick={async () => {
            if (
              await confirm({
                title: `Delete ${data.page.name}?`,
                description: "Its components, incidents and history go too. This cannot be undone.",
                confirmLabel: "Delete page",
                danger: true,
              })
            )
              void remove.run();
          }}
        >
          <Trash2 /> Delete page
        </Button>
      </div>
    </Card>
  );
}
