"use client";

import * as React from "react";
import { ArrowDown, ArrowUp, Pencil, Plus, Rows3, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm";
import { Dialog, DialogBody, DialogClose, DialogContent, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Card, CardHeader, EmptyState } from "@/components/ui/misc";
import { Select } from "@/components/ui/select";
import { useAction } from "@/hooks/use-action";
import { addStatusComponent, removeStatusComponent, reorderStatusComponents, updateStatusComponent } from "@/server/actions/status-pages";
import type { EditorData, EditorService } from "@/server/status-pages/admin";
import { LEVEL_TEXT } from "@/lib/status-page";
import { cn } from "@/lib/utils";
import { levelDot } from "../badges";

type Component = EditorData["components"][number];

const checkText: Record<NonNullable<EditorService["check"]>, string> = { up: "Up", down: "Down", pending: "Checking", paused: "Check paused" };

export function ComponentsTab({ data, canManage }: { data: EditorData; canManage: boolean }) {
  const [editing, setEditing] = React.useState<Component | "new" | null>(null);
  const confirm = useConfirm();
  const remove = useAction((id: string) => removeStatusComponent(id));
  const reorder = useAction((ids: string[]) => reorderStatusComponents(data.page.id, ids));
  const levels = new Map(data.view.groups.flatMap((g) => g.components.map((c) => [c.id, c.level] as const)));
  const services = new Map(data.services.map((s) => [s.id, s]));
  const ids = data.components.map((c) => c.id);

  const move = (i: number, by: -1 | 1) => {
    const next = [...ids];
    [next[i], next[i + by]] = [next[i + by], next[i]];
    void reorder.run(next);
  };

  return (
    <Card>
      <CardHeader
        title="Components"
        description="What visitors see, top to bottom. A component follows the uptime check of its service, and the incidents you post for it."
        actions={
          canManage && data.components.length > 0 ? (
            <Button size="sm" onClick={() => setEditing("new")}>
              <Plus /> Add component
            </Button>
          ) : undefined
        }
      />
      {data.components.length === 0 ? (
        <EmptyState
          icon={<Rows3 />}
          title="No components yet"
          description="Add the services visitors care about, like Website, API or Dashboard."
          action={
            canManage ? (
              <Button size="sm" variant="primary" onClick={() => setEditing("new")}>
                <Plus /> Add component
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="divide-y divide-line">
          {data.components.map((c, i) => {
            const service = c.serviceId ? services.get(c.serviceId) : undefined;
            const level = levels.get(c.id) ?? "unknown";
            const groupStart = c.group && data.components[i - 1]?.group !== c.group;
            return (
              <React.Fragment key={c.id}>
                {groupStart && <p className="bg-surface-2 px-5 py-1.5 text-[11px] font-semibold tracking-wide text-muted uppercase">{c.group}</p>}
                <div className="flex items-center gap-3 px-5 py-3">
                  <span className={cn("size-2 flex-none rounded-full", levelDot[level])} title={LEVEL_TEXT[level]} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13px] font-medium text-fg">{c.name}</p>
                    <p className="truncate text-xs text-muted">
                      {service ? (
                        <>
                          {service.project} / {service.name} · {service.check ? checkText[service.check] : <span className="text-warn">No uptime check</span>}
                        </>
                      ) : (
                        "No check: changes only with the incidents you post"
                      )}
                    </p>
                  </div>
                  {canManage && (
                    <div className="flex flex-none items-center gap-0.5">
                      <Button variant="ghost" size="icon-sm" aria-label={`Move ${c.name} up`} disabled={i === 0 || reorder.pending} onClick={() => move(i, -1)}>
                        <ArrowUp />
                      </Button>
                      <Button variant="ghost" size="icon-sm" aria-label={`Move ${c.name} down`} disabled={i === ids.length - 1 || reorder.pending} onClick={() => move(i, 1)}>
                        <ArrowDown />
                      </Button>
                      <Button variant="ghost" size="icon-sm" aria-label={`Edit ${c.name}`} onClick={() => setEditing(c)}>
                        <Pencil />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Remove ${c.name}`}
                        onClick={async () => {
                          if (
                            await confirm({
                              title: `Remove ${c.name}?`,
                              description: "It goes from the page. Its service and uptime check stay.",
                              confirmLabel: "Remove",
                              danger: true,
                            })
                          )
                            void remove.run(c.id);
                        }}
                      >
                        <Trash2 />
                      </Button>
                    </div>
                  )}
                </div>
              </React.Fragment>
            );
          })}
        </div>
      )}
      <ComponentDialog data={data} component={editing} onClose={() => setEditing(null)} />
    </Card>
  );
}

const MANUAL = "__manual";

function ComponentDialog({ data, component, onClose }: { data: EditorData; component: Component | "new" | null; onClose: () => void }) {
  const editing = component && component !== "new" ? component : null;
  const [serviceId, setServiceId] = React.useState<string>(MANUAL);
  const [name, setName] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [group, setGroup] = React.useState("");
  const named = React.useRef(false);

  React.useEffect(() => {
    if (!component) return;
    setServiceId(editing?.serviceId ?? (component === "new" ? (data.services.find((s) => s.check && !data.components.some((c) => c.serviceId === s.id))?.id ?? MANUAL) : MANUAL));
    setName(editing?.name ?? "");
    setDescription(editing?.description ?? "");
    setGroup(editing?.group ?? "");
    named.current = !!editing;
  }, [component, editing, data.services, data.components]);

  // The service's name until the owner types their own.
  const service = data.services.find((s) => s.id === serviceId);
  React.useEffect(() => {
    if (!named.current && service) setName(service.name);
  }, [service]);

  const input = { serviceId: serviceId === MANUAL ? null : serviceId, name, description: description || null, group: group || null };
  const save = useAction(() => (editing ? updateStatusComponent(editing.id, input) : addStatusComponent(data.page.id, input)), { onSuccess: onClose });
  const groups = [...new Set(data.components.map((c) => c.group).filter((g): g is string => !!g))];

  return (
    <Dialog open={!!component} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void save.run();
          }}
        >
          <DialogHeader title={editing ? `Edit ${editing.name}` : "Add component"} description="Visitors see the name you give it here, never the service's own name or address." />
          <DialogBody>
            <Field
              label="Follows"
              description={
                service && !service.check ? "This service has no uptime check yet. Turn one on in its Settings → Monitoring, or the component always shows Operational." : undefined
              }
            >
              <Select
                value={serviceId}
                onValueChange={setServiceId}
                options={[
                  { value: MANUAL, label: "Nothing (I post incidents myself)" },
                  ...data.services.map((s) => ({
                    value: s.id,
                    label: `${s.project} / ${s.name}`,
                    description: s.check ? `Uptime check: ${checkText[s.check]}` : "No uptime check",
                  })),
                ]}
              />
            </Field>
            <Field label="Name">
              <Input
                value={name}
                onChange={(e) => {
                  named.current = true;
                  setName(e.target.value);
                }}
                placeholder="API"
                maxLength={80}
              />
            </Field>
            <Field label="Description" optional description="A short line under the name, like “Payments and checkout”.">
              <Input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={300} />
            </Field>
            <Field label="Group" optional description="Components with the same group show under one heading.">
              <Input value={group} onChange={(e) => setGroup(e.target.value)} list="status-groups" placeholder="Core services" maxLength={60} />
              <datalist id="status-groups">
                {groups.map((g) => (
                  <option key={g} value={g} />
                ))}
              </datalist>
            </Field>
          </DialogBody>
          <DialogFooter>
            <DialogClose render={<Button variant="ghost" />}>Cancel</DialogClose>
            <Button type="submit" variant="primary" loading={save.pending} disabled={!name.trim()}>
              {editing ? "Save" : "Add"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
