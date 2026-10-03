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
  kind: "http" | "loki";
  url: string;
  enabled: boolean;
  /** The header name or Loki user saved, never the secret itself. */
  headerName: string | null;
  username: string | null;
  hasSecret: boolean;
  projectIds: string[] | null;
};

const kindLabel = { http: "HTTP endpoint", loki: "Grafana Loki" } as const;

export function LogDrains({ drains, projects }: { drains: DrainItem[]; projects: { id: string; name: string }[] }) {
  const confirm = useConfirm();
  const [editing, setEditing] = React.useState<DrainItem | "new" | null>(null);
  const [testing, setTesting] = React.useState<string | null>(null);
  const test = useAction(testLogDrain, { result: "Test line sent", refresh: false });
  const toggle = useAction(setLogDrainEnabled);
  const remove = useAction(deleteLogDrain);
  const projectName = (id: string) => projects.find((p) => p.id === id)?.name ?? "Removed project";

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
              description="Add an HTTP endpoint (Better Stack, Axiom, Datadog, your own) or Grafana Loki. Each server sends its containers' logs there."
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
                      {kindLabel[d.kind]} · <span className="font-mono">{new URL(d.url).host}</span>
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
                <p className="text-xs text-muted">{d.projectIds?.length ? `Projects: ${d.projectIds.map(projectName).join(", ")}` : "Every project"}</p>
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

function DrainDialog({ drain, projects, onClose }: { drain: DrainItem | null; projects: { id: string; name: string }[]; onClose: () => void }) {
  const [form, setForm] = React.useState({
    name: drain?.name ?? "",
    kind: drain?.kind ?? ("http" as "http" | "loki"),
    url: drain?.url ?? "",
    headerName: drain?.headerName ?? "Authorization",
    headerValue: "",
    username: drain?.username ?? "",
    password: "",
    projectIds: drain?.projectIds ?? [],
  });
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));
  const save = useAction(() => (drain ? updateLogDrain(drain.id, form) : addLogDrain(form)), { onSuccess: onClose });
  // A stored secret is kept when its field is left empty, as long as the address stays the same.
  const keeps = !!drain?.hasSecret && form.url === drain.url;
  const all = !form.projectIds.length;
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
                <Select
                  value={form.kind}
                  onValueChange={(kind) => set({ kind: kind as "http" | "loki" })}
                  options={[
                    { value: "http", label: "HTTP endpoint", description: "JSON batches, POST" },
                    { value: "loki", label: "Grafana Loki", description: "Loki's push API" },
                  ]}
                />
              </Field>
            </div>
            <Field
              label="URL"
              description={
                form.kind === "loki"
                  ? "The Loki address, like https://logs-prod-012.grafana.net. The push path is added."
                  : "Lines arrive as a JSON array of objects, one per line."
              }
            >
              <Input
                value={form.url}
                onChange={(e) => set({ url: e.target.value })}
                placeholder={form.kind === "loki" ? "https://loki.example.com" : "https://in.logs.example.com"}
                className="font-mono text-[13px]"
                spellCheck={false}
              />
            </Field>
            {form.kind === "http" ? (
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
            ) : (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label="User" optional>
                  <Input value={form.username} onChange={(e) => set({ username: e.target.value })} placeholder="123456" autoComplete="off" />
                </Field>
                <Field label="Password or token" description={keeps ? "Leave empty to keep the saved one." : undefined}>
                  <Input value={form.password} onChange={(e) => set({ password: e.target.value })} type="password" autoComplete="off" placeholder={keeps ? "••••••••" : ""} />
                </Field>
              </div>
            )}
            <Field label="Projects">
              <div className="flex flex-col gap-2">
                <label className="flex items-center gap-2.5 text-[13px] text-fg-2">
                  <Checkbox checked={all} onCheckedChange={(c) => set({ projectIds: c ? [] : projects.slice(0, 1).map((p) => p.id) })} disabled={!projects.length} />
                  Every project, new ones too
                </label>
                {!all && (
                  <div className="flex max-h-48 flex-col gap-2 overflow-y-auto pl-6">
                    {projects.map((p) => (
                      <label key={p.id} className="flex items-center gap-2.5 text-[13px] text-fg-2">
                        <Checkbox
                          checked={form.projectIds.includes(p.id)}
                          onCheckedChange={(c) => {
                            const next = c ? [...form.projectIds, p.id] : form.projectIds.filter((id) => id !== p.id);
                            if (next.length) set({ projectIds: next });
                          }}
                        />
                        {p.name}
                      </label>
                    ))}
                  </div>
                )}
              </div>
            </Field>
          </DialogBody>
          <DialogFooter>
            <DialogClose render={<Button variant="ghost" size="sm" type="button" />}>Cancel</DialogClose>
            <Button type="submit" variant="primary" size="sm" loading={save.pending}>
              {drain ? "Save" : "Add log drain"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
