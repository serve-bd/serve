"use client";

import * as React from "react";
import { CalendarClock, Megaphone, MessageSquarePlus, Pencil, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { useConfirm } from "@/components/ui/confirm";
import { Dialog, DialogBody, DialogClose, DialogContent, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Field, Label } from "@/components/ui/field";
import { Input, Textarea } from "@/components/ui/input";
import { Badge, Card, CardHeader, EmptyState } from "@/components/ui/misc";
import { Select } from "@/components/ui/select";
import { TimeInput } from "@/components/ui/time-input";
import { useAction } from "@/hooks/use-action";
import { addStatusUpdate, createStatusNotice, deleteStatusNotice, editStatusNotice } from "@/server/actions/status-pages";
import type { EditorData } from "@/server/status-pages/admin";
import { IMPACT_TEXT, INCIDENT_STATES, type IncidentImpact, maintenancePhase, STATE_TEXT } from "@/lib/status-page";

type Notice = EditorData["notices"][number];

const pad = (n: number) => String(n).padStart(2, "0");
/** "YYYY-MM-DDTHH:MM" in the browser's zone. */
function localValue(d: Date) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

function phaseOf(n: Notice) {
  return n.kind === "maintenance" ? maintenancePhase(n) : n.resolvedAt ? "completed" : "in-progress";
}

export function NoticesTab({ data, canManage }: { data: EditorData; canManage: boolean }) {
  const [creating, setCreating] = React.useState<"incident" | "maintenance" | null>(null);
  const [editing, setEditing] = React.useState<Notice | null>(null);
  const [updating, setUpdating] = React.useState<Notice | null>(null);
  // Times read after mounting: the server's clock and zone are not the browser's.
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => setMounted(true), []);

  const ongoing = data.notices.filter((n) => phaseOf(n) === "in-progress");
  const planned = data.notices.filter((n) => phaseOf(n) === "scheduled").reverse();
  const past = data.notices.filter((n) => phaseOf(n) === "completed");
  const list = (title: string, items: Notice[]) =>
    items.length > 0 && (
      <div>
        <p className="border-b border-line bg-surface-2 px-5 py-1.5 text-[11px] font-semibold tracking-wide text-muted uppercase">{title}</p>
        <div className="divide-y divide-line">
          {items.map((n) => (
            <NoticeRow key={n.id} notice={n} data={data} canManage={canManage} mounted={mounted} onEdit={() => setEditing(n)} onUpdate={() => setUpdating(n)} />
          ))}
        </div>
      </div>
    );

  return (
    <Card>
      <CardHeader
        title="Incidents and maintenance"
        description={
          data.design.autoIncidents
            ? "Post what is going on. Outages your uptime checks find show up on the page by themselves."
            : "Post what is going on. Outages found by uptime checks stay off the page (Design → History)."
        }
        actions={
          canManage ? (
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={() => setCreating("maintenance")}>
                <CalendarClock /> Plan maintenance
              </Button>
              <Button size="sm" variant="primary" onClick={() => setCreating("incident")}>
                <Megaphone /> Report incident
              </Button>
            </div>
          ) : undefined
        }
      />
      {data.notices.length === 0 ? (
        <EmptyState icon={<Megaphone />} title="Nothing posted yet" description="When something breaks, report it here: visitors see it at once, with every update you add." />
      ) : (
        <div className="divide-y divide-line">
          {list("Ongoing", ongoing)}
          {list("Planned", planned)}
          {list("Past", past)}
        </div>
      )}
      <NoticeDialog data={data} kind={creating ?? editing?.kind ?? null} notice={editing} onClose={() => (setCreating(null), setEditing(null))} />
      <UpdateDialog notice={updating} onClose={() => setUpdating(null)} />
    </Card>
  );
}

function NoticeRow({
  notice,
  data,
  canManage,
  mounted,
  onEdit,
  onUpdate,
}: {
  notice: Notice;
  data: EditorData;
  canManage: boolean;
  mounted: boolean;
  onEdit: () => void;
  onUpdate: () => void;
}) {
  const confirm = useConfirm();
  const remove = useAction(() => deleteStatusNotice(notice.id));
  const phase = phaseOf(notice);
  const names = notice.componentIds.map((id) => data.components.find((c) => c.id === id)?.name).filter(Boolean);
  const state = notice.kind === "maintenance" ? STATE_TEXT[phase] : STATE_TEXT[notice.state];
  const tone = notice.kind === "maintenance" ? "info" : phase === "completed" ? "neutral" : notice.impact === "minor" ? "warn" : "bad";
  const latest = notice.updates[0];
  return (
    <div className="flex items-start gap-3 px-5 py-3.5">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-[13px] font-semibold text-fg">{notice.title}</p>
          <Badge tone={tone}>{state}</Badge>
          {notice.kind === "incident" && phase !== "completed" && <span className="text-xs text-muted">{IMPACT_TEXT[notice.impact]}</span>}
        </div>
        <p className="mt-0.5 text-xs text-muted">
          {mounted &&
            (notice.kind === "maintenance" && notice.startsAt && notice.endsAt
              ? `${when(notice.startsAt)} – ${when(notice.endsAt)}`
              : `Started ${when(notice.startsAt ?? notice.createdAt)}${notice.resolvedAt ? ` · resolved ${when(notice.resolvedAt)}` : ""}`)}
          {names.length > 0 && ` · ${names.join(", ")}`}
        </p>
        {latest && (
          <p className="mt-1.5 line-clamp-2 text-[13px] leading-relaxed text-fg-2">
            <span className="font-medium text-fg">{STATE_TEXT[latest.state as keyof typeof STATE_TEXT] ?? latest.state}</span> — {latest.body}
          </p>
        )}
      </div>
      {canManage && (
        <div className="flex flex-none items-center gap-0.5">
          {phase !== "completed" && (
            <Button size="sm" onClick={onUpdate}>
              <MessageSquarePlus /> Update
            </Button>
          )}
          <Button variant="ghost" size="icon-sm" aria-label={`Edit ${notice.title}`} onClick={onEdit}>
            <Pencil />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Delete ${notice.title}`}
            onClick={async () => {
              if (
                await confirm({ title: `Delete ${notice.title}?`, description: "It goes from the page and its history, with every update.", confirmLabel: "Delete", danger: true })
              )
                void remove.run();
            }}
          >
            <Trash2 />
          </Button>
        </div>
      )}
    </div>
  );
}

function DateTimeField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  const [date, time] = value.split("T");
  return (
    <div className="flex flex-col gap-1.5">
      <Label>{label}</Label>
      <div className="flex flex-wrap items-center gap-2">
        <Input type="date" value={date} onChange={(e) => onChange(`${e.target.value}T${time}`)} className="w-[10.5rem]" aria-label={`${label} date`} />
        <TimeInput value={time} onChange={(t) => onChange(`${date}T${t}`)} />
      </div>
    </div>
  );
}

/** A new incident or maintenance window, or changes to one. */
function NoticeDialog({ data, kind, notice, onClose }: { data: EditorData; kind: "incident" | "maintenance" | null; notice: Notice | null; onClose: () => void }) {
  const [title, setTitle] = React.useState("");
  const [impact, setImpact] = React.useState<IncidentImpact>("major");
  const [state, setState] = React.useState("investigating");
  const [components, setComponents] = React.useState<string[]>([]);
  const [body, setBody] = React.useState("");
  const [startsAt, setStartsAt] = React.useState("");
  const [endsAt, setEndsAt] = React.useState("");

  React.useEffect(() => {
    if (!kind) return;
    // A new window starts at the next full hour and lasts one hour.
    const start = new Date();
    start.setMinutes(0, 0, 0);
    start.setHours(start.getHours() + 1);
    setTitle(notice?.title ?? "");
    setImpact(notice?.impact ?? "major");
    setState("investigating");
    setComponents(notice?.componentIds ?? []);
    setBody("");
    setStartsAt(localValue(notice?.startsAt ? new Date(notice.startsAt) : start));
    setEndsAt(localValue(notice?.endsAt ? new Date(notice.endsAt) : new Date(start.getTime() + 3600_000)));
  }, [kind, notice]);

  const iso = (v: string) => (v ? new Date(v).toISOString() : null);
  const save = useAction(
    () =>
      notice
        ? editStatusNotice(notice.id, {
            title,
            impact,
            componentIds: components,
            startsAt: kind === "maintenance" ? iso(startsAt) : null,
            endsAt: kind === "maintenance" ? iso(endsAt) : null,
          })
        : createStatusNotice(data.page.id, {
            kind: kind!,
            title,
            impact,
            state,
            componentIds: components,
            body,
            startsAt: kind === "maintenance" ? iso(startsAt) : null,
            endsAt: kind === "maintenance" ? iso(endsAt) : null,
          }),
    { onSuccess: onClose },
  );
  const maintenance = kind === "maintenance";

  return (
    <Dialog open={!!kind} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void save.run();
          }}
        >
          <DialogHeader
            title={notice ? `Edit ${notice.title}` : maintenance ? "Plan maintenance" : "Report incident"}
            description={
              notice
                ? undefined
                : maintenance
                  ? "Visitors see it ahead of time. During the window its components show Under maintenance, and outages your checks find stay off the page."
                  : "It shows on the page at once. Add updates as you learn more."
            }
          />
          <DialogBody>
            <Field label="Title">
              <Input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder={maintenance ? "Database upgrade" : "Checkout is failing for some customers"}
                maxLength={160}
                autoFocus
              />
            </Field>
            {!maintenance && (
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Impact">
                  <Select
                    value={impact}
                    onValueChange={(v) => setImpact(v as IncidentImpact)}
                    options={(["minor", "major", "critical"] as const).map((i) => ({ value: i, label: IMPACT_TEXT[i] }))}
                  />
                </Field>
                {!notice && (
                  <Field label="State">
                    <Select value={state} onValueChange={setState} options={INCIDENT_STATES.map((s) => ({ value: s, label: STATE_TEXT[s] }))} />
                  </Field>
                )}
              </div>
            )}
            {maintenance && (
              <div className="grid gap-4 sm:grid-cols-2">
                <DateTimeField label="Starts" value={startsAt} onChange={setStartsAt} />
                <DateTimeField label="Ends" value={endsAt} onChange={setEndsAt} />
              </div>
            )}
            <div className="flex flex-col gap-1.5">
              <Label>Affected components</Label>
              {data.components.length === 0 ? (
                <p className="text-xs text-muted">The page has no components yet.</p>
              ) : (
                <div className="grid gap-1.5 rounded-lg border border-line p-3 sm:grid-cols-2">
                  {data.components.map((c) => (
                    <label key={c.id} className="flex min-w-0 items-center gap-2 text-[13px] text-fg-2">
                      <Checkbox checked={components.includes(c.id)} onCheckedChange={(on) => setComponents((list) => (on ? [...list, c.id] : list.filter((x) => x !== c.id)))} />
                      <span className="truncate">{c.name}</span>
                    </label>
                  ))}
                </div>
              )}
            </div>
            {!notice && (
              <Field
                label="Message"
                optional={maintenance}
                description={maintenance ? "What changes, and what visitors may notice." : "What visitors notice, and what you are doing about it."}
              >
                <Textarea value={body} onChange={(e) => setBody(e.target.value)} rows={4} maxLength={5000} />
              </Field>
            )}
          </DialogBody>
          <DialogFooter>
            <DialogClose render={<Button variant="ghost" />}>Cancel</DialogClose>
            <Button type="submit" variant="primary" loading={save.pending} disabled={!title.trim() || (!notice && !maintenance && !body.trim())}>
              {notice ? "Save" : maintenance ? "Plan" : "Post"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function UpdateDialog({ notice, onClose }: { notice: Notice | null; onClose: () => void }) {
  const maintenance = notice?.kind === "maintenance";
  const [state, setState] = React.useState("monitoring");
  const [body, setBody] = React.useState("");
  React.useEffect(() => {
    if (!notice) return;
    // The next step is the usual pick: investigating → identified → monitoring → resolved.
    const next = INCIDENT_STATES[Math.min(INCIDENT_STATES.indexOf(notice.state) + 1, INCIDENT_STATES.length - 1)];
    setState(notice.kind === "maintenance" ? (maintenancePhase(notice) === "scheduled" ? "scheduled" : "in-progress") : next);
    setBody("");
  }, [notice]);
  const save = useAction(() => addStatusUpdate(notice!.id, { state, body }), { onSuccess: onClose });
  const states = maintenance ? (["scheduled", "in-progress", "completed"] as const) : INCIDENT_STATES;
  return (
    <Dialog open={!!notice} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void save.run();
          }}
        >
          <DialogHeader
            title={`Update ${notice?.title ?? ""}`}
            description={maintenance ? "Completed ends the window now, even before its planned end." : "Resolved closes the incident; its components go back to their checks."}
          />
          <DialogBody>
            <Field label="State">
              <Select value={state} onValueChange={setState} options={states.map((s) => ({ value: s, label: STATE_TEXT[s] }))} />
            </Field>
            <Field label="Message">
              <Textarea value={body} onChange={(e) => setBody(e.target.value)} rows={4} maxLength={5000} autoFocus />
            </Field>
          </DialogBody>
          <DialogFooter>
            <DialogClose render={<Button variant="ghost" />}>Cancel</DialogClose>
            <Button type="submit" variant="primary" loading={save.pending} disabled={!body.trim()}>
              Post update
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
