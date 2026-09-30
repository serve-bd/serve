"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowUpRight, Moon, Send, Timer } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardBody, CardFooter, CardHeader, CopyButton } from "@/components/ui/misc";
import { Field } from "@/components/ui/field";
import { Input, Textarea } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Combobox } from "@/components/ui/combobox";
import { Switch, SwitchRow } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { PageBody, PageHeader } from "@/components/shell/page-header";
import { useAction } from "@/hooks/use-action";
import { useRouter } from "@/hooks/use-router";
import {
  type ChannelScope,
  defaultChannelEvents,
  fillTemplate,
  type MessageTemplate,
  notifyEventCatalog,
  notifyEventGroups,
  placeholders,
  type ProviderField,
  providerInfo,
  type QuietHours,
  type Severity,
  severityOptions,
  webhookExample,
} from "@/lib/notifications";
import { cn } from "@/lib/utils";
import { saveNotificationChannel, testNotificationChannel } from "@/server/actions/notifications";
import { ProviderIcon } from "./provider-icon";

export type ScopeProject = { id: string; name: string; environments: { id: string; name: string; services: { id: string; name: string }[] }[] };

export type ChannelForm = {
  name: string;
  config: Record<string, string>;
  events: string[];
  scope: ChannelScope | null;
  minSeverity: Severity;
  quietHours: QuietHours | null;
  throttleMinutes: number;
  template: MessageTemplate | null;
};

const throttleOptions = [
  { value: "0", label: "Send every notification" },
  { value: "5", label: "Group repeats within 5 minutes" },
  { value: "15", label: "Group repeats within 15 minutes" },
  { value: "30", label: "Group repeats within 30 minutes" },
  { value: "60", label: "Group repeats within 1 hour" },
  { value: "180", label: "Group repeats within 3 hours" },
  { value: "1440", label: "Group repeats within 1 day" },
];

const sampleValues = {
  title: "api failed to deploy",
  body: "The build exited with code 1.",
  event: "Deployment failed",
  status: "failed",
  severity: "warning",
  service: "api",
  project: "Shop",
  environment: "production",
  server: "localhost",
  organization: "Acme",
  error: "The build exited with code 1.",
  url: "https://serve.example.com/projects/p1/services/s1/deployments/d1",
};

const browserZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
};

export function ChannelEditor(props: {
  channelId: string | null;
  kind: string;
  initial: ChannelForm;
  savedSecrets: string[];
  tree: ScopeProject[];
  isAdmin: boolean;
  isRoot: boolean;
  /** The organization brought servers of its own: their alerts come to it. */
  hasServers?: boolean;
  emailReady: boolean;
}) {
  const provider = providerInfo(props.kind)!;
  const router = useRouter();
  const [form, setForm] = React.useState<ChannelForm>(props.initial);
  const set = (patch: Partial<ChannelForm>) => setForm((f) => ({ ...f, ...patch }));
  const readOnly = !props.isAdmin;
  const alerting = !!provider.alerting;

  const payload = () => ({ ...form, kind: props.kind, template: form.template });
  const save = useAction(() => saveNotificationChannel(props.channelId, payload()), {
    success: props.channelId ? "Channel saved" : "Channel added",
    onSuccess: () => router.push("/integrations/notifications"),
  });
  const test = useAction(() => testNotificationChannel(props.channelId, { kind: props.kind, config: form.config, template: form.template }), {
    success: "Test sent",
    refresh: !!props.channelId,
  });

  const events = notifyEventCatalog.filter((e) => props.isRoot || (e.group !== "Instance" && (e.group !== "Servers" || props.hasServers)));
  const groups = notifyEventGroups.filter((g) => events.some((e) => e.group === g));

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: "Notifications", href: "/integrations/notifications" }, { label: props.channelId ? props.initial.name : `New ${provider.label} channel` }]}
        title={
          <span className="flex items-center gap-3">
            <ProviderIcon kind={props.kind} />
            {props.channelId ? props.initial.name : `Add ${provider.label}`}
          </span>
        }
        description={
          <>
            {provider.description}{" "}
            {provider.docs && (
              <a href={provider.docs} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-accent hover:underline">
                How to set it up <ArrowUpRight className="size-3" />
              </a>
            )}
          </>
        }
      />
      <PageBody>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void save.run();
          }}
          className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,1fr)_320px]"
        >
          <fieldset disabled={readOnly} className="flex min-w-0 flex-col gap-6">
            {/* Connection */}
            <Card>
              <CardHeader title="Connection" description={`Where ${provider.label} notifications go. Secrets are stored encrypted.`} />
              <CardBody className="grid grid-cols-1 gap-4 py-5 sm:grid-cols-2">
                <Field label="Name" className="sm:col-span-2" description="Shown in the channel list and the delivery history.">
                  <Input value={form.name} onChange={(e) => set({ name: e.target.value })} required maxLength={60} />
                </Field>
                {provider.fields.map((f) => (
                  <ConfigField
                    key={f.key}
                    field={f}
                    value={form.config[f.key] ?? ""}
                    saved={props.savedSecrets.includes(f.key)}
                    onChange={(v) => set({ config: { ...form.config, [f.key]: v } })}
                  />
                ))}
                {props.kind === "email" && !props.emailReady && (
                  <p className="rounded-xl border border-warn/25 bg-warn-soft px-3 py-2 text-[13px] text-fg-2 sm:col-span-2">
                    Email is not set up on this instance yet. A Root admin can set it up in{" "}
                    <Link href="/settings/email" className="font-medium text-accent hover:underline">
                      Settings → Email
                    </Link>
                    .
                  </p>
                )}
              </CardBody>
            </Card>

            {/* Events */}
            <Card>
              <CardHeader
                title="Events"
                description="What this channel is told about."
                actions={
                  <div className="flex gap-1">
                    <Button size="sm" variant="ghost" onClick={() => set({ events: defaultChannelEvents.filter((id) => events.some((e) => e.id === id)) })}>
                      Problems
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => set({ events: events.map((e) => e.id) })}>
                      All
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => set({ events: [] })}>
                      None
                    </Button>
                  </div>
                }
              />
              <div className="grid grid-cols-1 gap-px bg-line sm:grid-cols-2">
                {groups.map((g) => {
                  const inGroup = events.filter((e) => e.group === g);
                  const on = inGroup.filter((e) => form.events.includes(e.id)).length;
                  return (
                    <div key={g} className="flex flex-col gap-2 bg-surface px-5 py-4">
                      <label className="flex items-center gap-2 text-[13px] font-semibold text-fg">
                        <Checkbox
                          checked={on === inGroup.length}
                          indeterminate={on > 0 && on < inGroup.length}
                          onCheckedChange={(c) =>
                            set({ events: c ? [...new Set([...form.events, ...inGroup.map((e) => e.id)])] : form.events.filter((id) => !inGroup.some((e) => e.id === id)) })
                          }
                        />
                        {g}
                      </label>
                      <div className="flex flex-col gap-1.5 pl-6">
                        {inGroup.map((ev) => (
                          <label key={ev.id} className="flex items-center gap-2 text-[13px] text-fg-2">
                            <Checkbox
                              checked={form.events.includes(ev.id)}
                              onCheckedChange={(c) => set({ events: c ? [...form.events, ev.id] : form.events.filter((x) => x !== ev.id) })}
                            />
                            <span className="min-w-0 flex-1">{ev.label}</span>
                            {ev.severity === "critical" && <span className="size-1.5 rounded-full bg-bad" title="Critical" />}
                          </label>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
              <CardFooter className="flex-wrap">
                <span className="text-[13px] text-fg-2">Send</span>
                <Select
                  size="sm"
                  className="w-full sm:w-72"
                  value={form.minSeverity}
                  onValueChange={(v) => set({ minSeverity: v as Severity })}
                  options={severityOptions.map((o) => ({ value: o.value, label: o.label, description: o.description }))}
                />
              </CardFooter>
            </Card>

            <ScopeCard tree={props.tree} scope={form.scope} onChange={(scope) => set({ scope })} isRoot={props.isRoot} hasServers={!!props.hasServers} />

            {!alerting && <MessageCard template={form.template} onChange={(template) => set({ template })} />}

            {/* Delivery */}
            <Card>
              <CardHeader title="Delivery" description="When messages go out and how repeats are handled." />
              <CardBody className="flex flex-col gap-5 py-5">
                {alerting ? (
                  <p className="text-[13px] text-muted">{provider.label} decides who is paged and when. An alert opens for each problem and closes when the problem is fixed.</p>
                ) : (
                  <QuietHoursFields value={form.quietHours} onChange={(quietHours) => set({ quietHours })} />
                )}
                <Field label="Repeats" description="The same event for the same service is sent once; repeats in the window are counted in the next message.">
                  <Select value={String(form.throttleMinutes)} onValueChange={(v) => set({ throttleMinutes: Number(v) })} options={throttleOptions} />
                </Field>
              </CardBody>
            </Card>

            {props.kind === "webhook" && <WebhookDocs />}
          </fieldset>

          <aside className="flex min-w-0 flex-col gap-4 lg:sticky lg:top-6">
            <Card>
              <CardBody className="flex flex-col gap-3 py-5">
                <div className="flex items-center gap-3">
                  <ProviderIcon kind={props.kind} size="lg" />
                  <div className="min-w-0">
                    <p className="truncate text-[15px] font-semibold text-fg">{form.name || provider.label}</p>
                    <p className="text-xs text-muted">{provider.label}</p>
                  </div>
                </div>
                <dl className="flex flex-col gap-2 border-t border-line pt-3 text-[13px]">
                  <Summary label="Events" value={`${form.events.length} of ${events.length}`} />
                  <Summary label="Sends" value={severityOptions.find((s) => s.value === form.minSeverity)?.label ?? ""} />
                  <Summary label="Covers" value={scopeSummary(form.scope, props.tree)} />
                  {!alerting && <Summary label="Quiet hours" value={form.quietHours?.enabled ? `${form.quietHours.start}–${form.quietHours.end}` : "Off"} />}
                  <Summary
                    label="Repeats"
                    value={form.throttleMinutes ? `Grouped, ${throttleOptions.find((o) => o.value === String(form.throttleMinutes))?.label.split("within ")[1]}` : "Every one"}
                  />
                </dl>
              </CardBody>
              {props.isAdmin && (
                <CardFooter className="flex-col items-stretch gap-2 py-4">
                  <Button type="submit" variant="primary" loading={save.pending} disabled={!form.events.length}>
                    {props.channelId ? "Save changes" : "Add channel"}
                  </Button>
                  <Button type="button" variant="secondary" loading={test.pending} onClick={() => test.run()}>
                    <Send /> Send test
                  </Button>
                  {!form.events.length && <p className="text-center text-xs text-muted">Pick at least one event.</p>}
                </CardFooter>
              )}
            </Card>
            {readOnly && <p className="px-1 text-xs text-muted">Only organization admins can change channels.</p>}
          </aside>
        </form>
      </PageBody>
    </>
  );
}

function Summary({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-muted">{label}</dt>
      <dd className="min-w-0 truncate text-right font-medium text-fg-2">{value}</dd>
    </div>
  );
}

function scopeSummary(scope: ChannelScope | null, tree: ScopeProject[]) {
  if (!scope) return "All projects";
  const n = scope.projectIds.length + scope.environmentIds.length + scope.serviceIds.length;
  if (!n) return scope.includeGlobal ? "All projects" : "Projects only";
  if (scope.projectIds.length === 1 && n === 1) return tree.find((p) => p.id === scope.projectIds[0])?.name ?? "1 project";
  return `${n} selected`;
}

function ConfigField({ field, value, saved, onChange }: { field: ProviderField; value: string; saved: boolean; onChange: (v: string) => void }) {
  const wide = field.type === "textarea" || field.key === "webhookUrl" || field.key === "url" || field.key === "to";
  const placeholder = saved ? "Saved. Type a new value to replace it." : field.placeholder;
  return (
    <Field label={field.label} optional={field.optional} description={field.description} className={cn(wide && "sm:col-span-2")}>
      {field.type === "select" ? (
        <Select value={value || field.options?.[0]?.value || ""} onValueChange={onChange} options={field.options ?? []} />
      ) : field.type === "textarea" ? (
        <Textarea value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} rows={3} className={cn(field.mono && "font-mono text-[12.5px]")} />
      ) : (
        <Input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          type={field.secret ? "password" : field.type === "url" ? "url" : "text"}
          required={!field.optional && !saved}
          className={cn(field.mono && "font-mono text-[13px]")}
        />
      )}
    </Field>
  );
}

function ScopeCard({
  tree,
  scope,
  onChange,
  isRoot,
  hasServers,
}: {
  tree: ScopeProject[];
  scope: ChannelScope | null;
  onChange: (s: ChannelScope | null) => void;
  isRoot: boolean;
  hasServers: boolean;
}) {
  const some = !!scope && scope.projectIds.length + scope.environmentIds.length + scope.serviceIds.length > 0;
  const [mode, setMode] = React.useState<"all" | "some">(some ? "some" : "all");
  const s: ChannelScope = scope ?? { projectIds: [], environmentIds: [], serviceIds: [], includeGlobal: true };
  const toggle = (key: "projectIds" | "environmentIds" | "serviceIds", id: string, on: boolean) =>
    onChange({ ...s, [key]: on ? [...new Set([...s[key], id])] : s[key].filter((x) => x !== id) });
  return (
    <Card>
      <CardHeader title="Projects" description="Limit the channel to some projects, environments or services." />
      <CardBody className="flex flex-col gap-4 py-5">
        <div className="grid grid-cols-2 gap-2">
          {(["all", "some"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => {
                setMode(m);
                if (m === "all") onChange(scope ? { ...s, projectIds: [], environmentIds: [], serviceIds: [] } : null);
              }}
              className={cn(
                "rounded-xl border px-3.5 py-2.5 text-left transition-colors",
                mode === m ? "border-accent bg-accent-soft/60 ring-1 ring-accent/30" : "border-line hover:border-line-strong hover:bg-hover",
              )}
            >
              <p className="text-[13px] font-medium text-fg">{m === "all" ? "All projects" : "Chosen projects"}</p>
              <p className="text-xs text-muted">{m === "all" ? "Includes new projects." : "Pick projects, environments or services."}</p>
            </button>
          ))}
        </div>
        {mode === "some" &&
          (tree.length === 0 ? (
            <p className="text-[13px] text-muted">This organization has no projects yet.</p>
          ) : (
            <div className="max-h-96 divide-y divide-line overflow-y-auto rounded-xl border border-line">
              {tree.map((p) => {
                const projectOn = s.projectIds.includes(p.id);
                return (
                  <div key={p.id} className="px-4 py-3">
                    <label className="flex items-center gap-2 text-[13px] font-semibold text-fg">
                      <Checkbox checked={projectOn} onCheckedChange={(c) => toggle("projectIds", p.id, !!c)} />
                      {p.name}
                      <span className="font-normal text-faint">whole project</span>
                    </label>
                    {!projectOn && p.environments.length > 0 && (
                      <div className="mt-2 flex flex-col gap-2 pl-6">
                        {p.environments.map((e) => {
                          const envOn = s.environmentIds.includes(e.id);
                          return (
                            <div key={e.id}>
                              <label className="flex items-center gap-2 text-[13px] text-fg-2">
                                <Checkbox checked={envOn} onCheckedChange={(c) => toggle("environmentIds", e.id, !!c)} />
                                <Badge>{e.name}</Badge>
                              </label>
                              {!envOn && e.services.length > 0 && (
                                <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1.5 pl-6">
                                  {e.services.map((svc) => (
                                    <label key={svc.id} className="flex items-center gap-2 text-[13px] text-fg-2">
                                      <Checkbox checked={s.serviceIds.includes(svc.id)} onCheckedChange={(c) => toggle("serviceIds", svc.id, !!c)} />
                                      {svc.name}
                                    </label>
                                  ))}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        <SwitchRow
          title={isRoot ? "Events outside projects" : hasServers ? "Server and certificate events" : "Certificate events"}
          description={
            isRoot
              ? "Servers, certificates and this instance itself are not part of a project."
              : hasServers
                ? "Your servers and certificates are not part of a project."
                : "Certificates are not part of a project."
          }
          checked={s.includeGlobal}
          onCheckedChange={(includeGlobal) => onChange({ ...s, includeGlobal })}
        />
      </CardBody>
    </Card>
  );
}

function MessageCard({ template, onChange }: { template: MessageTemplate | null; onChange: (t: MessageTemplate | null) => void }) {
  const t = template ?? { title: "", body: "" };
  const titleRef = React.useRef<HTMLInputElement>(null);
  const bodyRef = React.useRef<HTMLTextAreaElement>(null);
  const last = React.useRef<"title" | "body">("body");
  const insert = (key: string) => {
    const which = last.current;
    const el = which === "title" ? titleRef.current : bodyRef.current;
    const value = t[which];
    const at = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? value.length;
    const next = `${value.slice(0, at)}{${key}}${value.slice(end)}`;
    onChange({ ...t, [which]: next });
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(at + key.length + 2, at + key.length + 2);
    });
  };
  const title = t.title.trim() ? fillTemplate(t.title, sampleValues) : sampleValues.title;
  const body = t.body.trim() ? fillTemplate(t.body, sampleValues) : sampleValues.body;
  return (
    <Card>
      <CardHeader
        title="Message"
        description="Change the text if you like. Empty fields use the standard text."
        actions={
          template && (
            <Button size="sm" variant="ghost" onClick={() => onChange(null)}>
              Reset
            </Button>
          )
        }
      />
      <CardBody className="grid grid-cols-1 gap-4 py-5">
        <Field label="Title" optional>
          <Input
            ref={titleRef}
            value={t.title}
            onFocus={() => {
              last.current = "title";
            }}
            onChange={(e) => onChange({ ...t, title: e.target.value })}
            placeholder="{title}"
            maxLength={300}
          />
        </Field>
        <Field label="Text" optional>
          <Textarea
            ref={bodyRef}
            value={t.body}
            onFocus={() => {
              last.current = "body";
            }}
            onChange={(e) => onChange({ ...t, body: e.target.value })}
            placeholder={"{body}\n{project} / {environment}"}
            rows={4}
            maxLength={2000}
          />
        </Field>
        <div className="flex flex-col gap-2">
          <p className="text-xs text-muted">Insert a field:</p>
          <div className="flex flex-wrap gap-1.5">
            {placeholders.map((p) => (
              <button
                key={p.key}
                type="button"
                title={p.description}
                onClick={() => insert(p.key)}
                className="rounded-md border border-line bg-surface-2 px-1.5 py-0.5 font-mono text-[11.5px] text-fg-2 transition-colors hover:border-line-strong hover:text-fg"
              >
                {`{${p.key}}`}
              </button>
            ))}
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <p className="text-xs text-muted">Preview, for a failed deployment:</p>
          <div className="rounded-xl border border-line bg-sunken px-4 py-3">
            <p className="text-[13.5px] font-semibold text-fg">⚠️ {title}</p>
            {body && <p className="mt-1 text-[13px] whitespace-pre-wrap text-fg-2">{body}</p>}
          </div>
        </div>
      </CardBody>
    </Card>
  );
}

function QuietHoursFields({ value, onChange }: { value: QuietHours | null; onChange: (q: QuietHours | null) => void }) {
  const q: QuietHours = value ?? { enabled: false, start: "22:00", end: "07:00", timezone: browserZone(), allowCritical: true, digest: true };
  const zones = React.useMemo(() => {
    let list: string[] = [];
    try {
      list = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone") ?? [];
    } catch {}
    if (!list.includes("UTC")) list = ["UTC", ...list];
    return list.map((z) => ({ value: z, label: z.replace(/_/g, " ") }));
  }, []);
  return (
    <div className="flex flex-col gap-4">
      <label className="flex items-start justify-between gap-6">
        <span className="flex items-start gap-3">
          <span className="mt-0.5 flex size-8 flex-none items-center justify-center rounded-lg bg-fg/[0.05] text-muted [&_svg]:size-4">
            <Moon />
          </span>
          <span className="flex flex-col gap-0.5">
            <span className="text-sm font-medium text-fg">Quiet hours</span>
            <span className="text-xs leading-relaxed text-muted">Hold notifications at night or on your off hours.</span>
          </span>
        </span>
        <Switch checked={q.enabled} onCheckedChange={(enabled) => onChange({ ...q, enabled })} className="mt-1" />
      </label>
      {q.enabled && (
        <div className="flex flex-col gap-4 rounded-xl border border-line bg-surface-2/60 p-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-[8rem_8rem_minmax(0,1fr)]">
            <Field label="From">
              <Input type="time" value={q.start} onChange={(e) => onChange({ ...q, start: e.target.value || "22:00" })} />
            </Field>
            <Field label="Until">
              <Input type="time" value={q.end} onChange={(e) => onChange({ ...q, end: e.target.value || "07:00" })} />
            </Field>
            <Field label="Time zone" className="col-span-2 sm:col-span-1">
              <Combobox value={q.timezone} onValueChange={(timezone) => onChange({ ...q, timezone })} options={zones} placeholder="Search time zones…" />
            </Field>
          </div>
          <SwitchRow
            title="Critical alerts still come through"
            description="Outages, crashes and failed backups are sent right away."
            checked={q.allowCritical}
            onCheckedChange={(allowCritical) => onChange({ ...q, allowCritical })}
          />
          <SwitchRow
            title="Send a summary afterwards"
            description="One message with everything that was held. Off drops them (they stay in the history)."
            checked={q.digest}
            onCheckedChange={(digest) => onChange({ ...q, digest })}
          />
        </div>
      )}
      {!q.enabled && (
        <p className="flex items-center gap-2 text-xs text-muted">
          <Timer className="size-3.5" /> Notifications are sent at any time.
        </p>
      )}
    </div>
  );
}

const verifySnippet = `import crypto from "node:crypto";

// req.body must be the raw request body (a string).
function verify(req, secret) {
  const ts = req.headers["x-serve-timestamp"];
  const sig = req.headers["x-serve-signature"]; // "sha256=<hex>"
  const expected = "sha256=" + crypto.createHmac("sha256", secret).update(ts + "." + req.body).digest("hex");
  const fresh = Math.abs(Date.now() / 1000 - Number(ts)) < 300;
  return fresh && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}`;

function WebhookDocs() {
  const example = JSON.stringify(webhookExample, null, 2);
  return (
    <Card>
      <CardHeader title="Payload" description={<>This JSON body is sent. Fields may be added over time; existing ones keep their meaning.</>} />
      <CardBody className="flex flex-col gap-4 py-5">
        <div className="relative">
          <pre className="max-h-80 overflow-auto rounded-xl border border-line bg-sunken p-4 font-mono text-[12px] leading-5 text-fg-2">{example}</pre>
          <CopyButton value={example} className="absolute top-2 right-2" />
        </div>
        <div className="grid grid-cols-1 gap-2 text-[13px] text-fg-2">
          <p>
            <code className="rounded bg-surface-2 px-1 font-mono text-[12px]">X-Serve-Event</code> holds the event, and{" "}
            <code className="rounded bg-surface-2 px-1 font-mono text-[12px]">X-Serve-Delivery</code> a unique id for each delivery. Retries keep the same id.
          </p>
          <p>
            With a signing secret, <code className="rounded bg-surface-2 px-1 font-mono text-[12px]">X-Serve-Signature</code> is{" "}
            <code className="rounded bg-surface-2 px-1 font-mono text-[12px]">sha256=</code> and the HMAC-SHA256 of{" "}
            <code className="rounded bg-surface-2 px-1 font-mono text-[12px]">{"<X-Serve-Timestamp>.<body>"}</code>.
          </p>
        </div>
        <div className="relative">
          <pre className="overflow-auto rounded-xl border border-line bg-sunken p-4 font-mono text-[12px] leading-5 text-fg-2">{verifySnippet}</pre>
          <CopyButton value={verifySnippet} className="absolute top-2 right-2" />
        </div>
      </CardBody>
    </Card>
  );
}
