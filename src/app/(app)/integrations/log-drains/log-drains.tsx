"use client";

import * as React from "react";
import { MoreHorizontal, Pencil, Plus, ScrollText, Trash2, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Card, EmptyState } from "@/components/ui/misc";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogBody, DialogClose, DialogContent, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { useConfirm } from "@/components/ui/confirm";
import { PageBody, PageHeader } from "@/components/shell/page-header";
import { useAction } from "@/hooks/use-action";
import { addLogDrain, deleteLogDrain, setLogDrainEnabled, testLogDrain, updateLogDrain } from "@/server/actions/log-drains";

export type DrainItem = {
  id: string;
  name: string;
  kind: Kind;
  url: string;
  enabled: boolean;
  /** The header name or Loki user saved, never the secret itself. */
  headerName: string | null;
  username: string | null;
  hasSecret: boolean;
  projectIds: string[] | null;
  serviceIds: string[] | null;
  index: string | null;
  sourcetype: string | null;
};

export type DrainProject = { id: string; name: string; services: { id: string; name: string }[] };

type Kind = "http" | "loki" | "elasticsearch" | "splunk" | "syslog";

const kinds: { value: Kind; label: string; description: string }[] = [
  { value: "http", label: "HTTP endpoint", description: "JSON batches: Better Stack, Axiom, Datadog, your own" },
  { value: "loki", label: "Grafana Loki", description: "Loki's push API" },
  { value: "elasticsearch", label: "Elasticsearch or OpenSearch", description: "Bulk API, one index a day" },
  { value: "splunk", label: "Splunk", description: "HTTP Event Collector" },
  { value: "syslog", label: "Syslog", description: "RFC 5424 over TCP, TLS or UDP: Papertrail, rsyslog" },
];

const urlHelp: Record<Kind, { placeholder: string; description: string }> = {
  http: { placeholder: "https://in.logs.example.com", description: "Lines arrive as a JSON array of objects, one per line." },
  loki: { placeholder: "https://loki.example.com", description: "The Loki address, like https://logs-prod-012.grafana.net. The push path is added." },
  elasticsearch: { placeholder: "https://elastic.example.com:9200", description: "The cluster address. Lines go to the index you name, one a day." },
  splunk: { placeholder: "https://splunk.example.com:8088", description: "The HTTP Event Collector address. The collector path is added." },
  syslog: { placeholder: "tls://logs.papertrailapp.com:12345", description: "tcp://, tls:// or udp://, with the port." },
};

/** "host:port" for any drain address, http or not. */
function shortHost(url: string) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

const kindLabel = Object.fromEntries(kinds.map((k) => [k.value, k.label])) as Record<Kind, string>;

export function LogDrains({ drains, projects }: { drains: DrainItem[]; projects: DrainProject[] }) {
  const confirm = useConfirm();
  const [editing, setEditing] = React.useState<DrainItem | "new" | null>(null);
  const [testing, setTesting] = React.useState<string | null>(null);
  const test = useAction(testLogDrain, { result: "Test line sent", refresh: false });
  const toggle = useAction(setLogDrainEnabled);
  const remove = useAction(deleteLogDrain);
  const projectName = (id: string) => projects.find((p) => p.id === id)?.name ?? "Removed project";
  const serviceName = (id: string) => projects.flatMap((p) => p.services).find((s) => s.id === id)?.name ?? "Removed service";
  const scopeText = (d: DrainItem) =>
    !d.projectIds?.length && !d.serviceIds?.length
      ? "Every service"
      : [
          ...(d.projectIds?.length ? [`Projects: ${d.projectIds.map(projectName).join(", ")}`] : []),
          ...(d.serviceIds?.length ? [`Services: ${d.serviceIds.map(serviceName).join(", ")}`] : []),
        ].join(" · ");

  return (
    <>
      <PageHeader
        title="Log drains"
        description="Send the logs of your apps, stacks and databases to your own log service as they are written."
        actions={
          <Button size="sm" variant="primary" onClick={() => setEditing("new")}>
            <Plus /> Add log drain
          </Button>
        }
      />
      <PageBody>
        {drains.length === 0 ? (
          <Card>
            <EmptyState
              icon={<ScrollText />}
              title="No log drains yet"
              description="Add an HTTP endpoint (Better Stack, Axiom, Datadog, your own), Grafana Loki, Elasticsearch, Splunk or syslog. Each server sends its containers' logs there."
              action={
                <Button size="sm" variant="primary" onClick={() => setEditing("new")}>
                  <Plus /> Add log drain
                </Button>
              }
            />
          </Card>
        ) : (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {drains.map((d) => (
              <Card key={d.id} className="flex flex-col gap-3 p-5">
                <div className="flex items-start gap-3">
                  <span className="flex size-10 flex-none items-center justify-center rounded-xl bg-fg/[0.05] text-muted" aria-hidden>
                    <ScrollText className="size-[18px]" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <h3 className="flex items-center gap-2 truncate text-[15px] font-semibold text-fg">
                      {d.name} {!d.enabled && <Badge>Paused</Badge>}
                    </h3>
                    <p className="mt-0.5 truncate text-xs text-muted">
                      {kindLabel[d.kind]} · <span className="font-mono">{shortHost(d.url)}</span>
                    </p>
                  </div>
                  <div className="flex flex-none items-center gap-1">
                    <Switch
                      checked={d.enabled}
                      onCheckedChange={(on) => void toggle.run(d.id, on)}
                      aria-label={d.enabled ? "Pause" : "Resume"}
                      title={d.enabled ? "Sending. Turn off to pause." : "Paused. Turn on to send again."}
                    />
                    <Button
                      size="sm"
                      variant="ghost"
                      title="Send a test line"
                      loading={testing === d.id}
                      onClick={async () => {
                        setTesting(d.id);
                        await test.run(d.id);
                        setTesting(null);
                      }}
                    >
                      <Zap /> <span className="hidden sm:inline">Test</span>
                    </Button>
                    <Menu>
                      <MenuTrigger render={<Button size="icon-sm" variant="ghost" aria-label="More actions" />}>
                        <MoreHorizontal />
                      </MenuTrigger>
                      <MenuContent>
                        <MenuItem onClick={() => setEditing(d)}>
                          <Pencil /> Edit
                        </MenuItem>
                        <MenuSeparator />
                        <MenuItem
                          danger
                          onClick={async () => {
                            if (
                              await confirm({
                                title: `Remove ${d.name}?`,
                                description: "Logs stop going there. What it received stays there.",
                                confirmLabel: "Remove",
                                danger: true,
                              })
                            )
                              void remove.run(d.id);
                          }}
                        >
                          <Trash2 /> Remove
                        </MenuItem>
                      </MenuContent>
                    </Menu>
                  </div>
                </div>
                <p className="line-clamp-2 text-xs text-muted">{scopeText(d)}</p>
              </Card>
            ))}
          </div>
        )}
        <p className="mt-6 text-xs leading-relaxed text-muted">
          Each server runs Vector next to Docker and sends what containers write from then on, with the project, environment, service and server of each line. Build logs stay in
          the dashboard.
        </p>
      </PageBody>
      {editing && <DrainDialog drain={editing === "new" ? null : editing} projects={projects} onClose={() => setEditing(null)} />}
    </>
  );
}

/** Add or edit a drain. From a service's settings, a new drain starts with that service picked. */
export function DrainDialog({ drain, projects, onClose, preset }: { drain: DrainItem | null; projects: DrainProject[]; onClose: () => void; preset?: { serviceIds: string[] } }) {
  const [form, setForm] = React.useState({
    name: drain?.name ?? "",
    kind: drain?.kind ?? ("http" as Kind),
    url: drain?.url ?? "",
    headerName: drain?.headerName ?? "Authorization",
    headerValue: "",
    username: drain?.username ?? "",
    password: "",
    projectIds: drain?.projectIds ?? [],
    serviceIds: drain?.serviceIds ?? preset?.serviceIds ?? [],
    index: drain?.index ?? "",
    sourcetype: drain?.sourcetype ?? "",
  });
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));
  const save = useAction(
    () => {
      // "Every service" saves no picks at all: that is what the server reads as everything.
      const data = everything ? { ...form, projectIds: [], serviceIds: [] } : form;
      return drain ? updateLogDrain(drain.id, data) : addLogDrain(data);
    },
    { onSuccess: onClose },
  );
  // A stored secret is kept when its field is left empty, as long as the address stays the same.
  const keeps = !!drain?.hasSecret && form.url === drain.url;
  const [everything, setEverything] = React.useState(!form.projectIds.length && !form.serviceIds.length);
  const nothing = !everything && !form.projectIds.length && !form.serviceIds.length;
  const toggle = (list: string[], id: string, on: boolean) => (on ? [...new Set([...list, id])] : list.filter((x) => x !== id));
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void save.run();
          }}
        >
          <DialogHeader title={drain ? `Edit ${drain.name}` : "Add log drain"} />
          <DialogBody className="flex flex-col gap-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Name">
                <Input value={form.name} onChange={(e) => set({ name: e.target.value })} placeholder="Better Stack" autoFocus />
              </Field>
              <Field label="Type">
                <Select value={form.kind} onValueChange={(kind) => set({ kind: kind as Kind })} options={kinds} />
              </Field>
            </div>
            <Field label="URL" description={urlHelp[form.kind].description}>
              <Input
                value={form.url}
                onChange={(e) => set({ url: e.target.value })}
                placeholder={urlHelp[form.kind].placeholder}
                className="font-mono text-[13px]"
                spellCheck={false}
              />
            </Field>
            {form.kind === "http" && (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
                <Field label="Header" optional>
                  <Input value={form.headerName} onChange={(e) => set({ headerName: e.target.value })} placeholder="Authorization" className="font-mono text-[13px]" />
                </Field>
                <Field label="Value" description={keeps ? "Leave empty to keep the saved value." : undefined}>
                  <Input
                    value={form.headerValue}
                    onChange={(e) => set({ headerValue: e.target.value })}
                    placeholder={keeps ? "••••••••" : "Bearer your-token"}
                    type="password"
                    autoComplete="off"
                    className="font-mono text-[13px]"
                  />
                </Field>
              </div>
            )}
            {(form.kind === "loki" || form.kind === "elasticsearch") && (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label="User" optional>
                  <Input value={form.username} onChange={(e) => set({ username: e.target.value })} placeholder={form.kind === "loki" ? "123456" : "elastic"} autoComplete="off" />
                </Field>
                <Field label="Password or token" description={keeps ? "Leave empty to keep the saved one." : undefined}>
                  <Input value={form.password} onChange={(e) => set({ password: e.target.value })} type="password" autoComplete="off" placeholder={keeps ? "••••••••" : ""} />
                </Field>
              </div>
            )}
            {form.kind === "splunk" && (
              <Field label="Token" description={keeps ? "Leave empty to keep the saved one." : "The HTTP Event Collector token."}>
                <Input
                  value={form.password}
                  onChange={(e) => set({ password: e.target.value })}
                  type="password"
                  autoComplete="off"
                  placeholder={keeps ? "••••••••" : ""}
                  className="font-mono text-[13px]"
                />
              </Field>
            )}
            {(form.kind === "elasticsearch" || form.kind === "splunk") && (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field
                  label="Index"
                  optional={form.kind === "splunk"}
                  description={form.kind === "elasticsearch" ? "Each day gets its own, like serve-logs-2026.10.04." : undefined}
                >
                  <Input
                    value={form.index}
                    onChange={(e) => set({ index: e.target.value })}
                    placeholder={form.kind === "elasticsearch" ? "serve-logs" : "main"}
                    className="font-mono text-[13px]"
                    spellCheck={false}
                  />
                </Field>
                {form.kind === "splunk" && (
                  <Field label="Source type" optional>
                    <Input value={form.sourcetype} onChange={(e) => set({ sourcetype: e.target.value })} placeholder="serve" className="font-mono text-[13px]" spellCheck={false} />
                  </Field>
                )}
              </div>
            )}
            <Field label="What to send" error={nothing ? "Pick at least one project or service." : undefined}>
              <div className="flex flex-col gap-2">
                <label className="flex items-center gap-2.5 text-[13px] text-fg-2">
                  <Checkbox checked={everything} onCheckedChange={(c) => setEverything(!!c)} />
                  Every service, new ones too
                </label>
                {!everything && (
                  <div className="flex max-h-64 flex-col gap-3 overflow-y-auto rounded-xl border border-line p-3">
                    {projects.map((p) => {
                      const whole = form.projectIds.includes(p.id);
                      return (
                        <div key={p.id} className="flex flex-col gap-1.5">
                          <label className="flex items-center gap-2.5 text-[13px] font-medium text-fg">
                            <Checkbox checked={whole} onCheckedChange={(c) => set({ projectIds: toggle(form.projectIds, p.id, !!c) })} />
                            {p.name}
                            <span className="text-xs font-normal text-faint">whole project, new services too</span>
                          </label>
                          {p.services.map((sv) => (
                            <label key={sv.id} className="flex items-center gap-2.5 pl-6 text-[13px] text-fg-2">
                              <Checkbox
                                checked={whole || form.serviceIds.includes(sv.id)}
                                disabled={whole}
                                onCheckedChange={(c) => set({ serviceIds: toggle(form.serviceIds, sv.id, !!c) })}
                              />
                              {sv.name}
                            </label>
                          ))}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </Field>
          </DialogBody>
          <DialogFooter>
            <DialogClose render={<Button variant="ghost" size="sm" type="button" />}>Cancel</DialogClose>
            <Button type="submit" variant="primary" size="sm" loading={save.pending} disabled={nothing}>
              {drain ? "Save" : "Add log drain"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
