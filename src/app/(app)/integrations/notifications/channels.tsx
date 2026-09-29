"use client";

import * as React from "react";
import { Bell, Pencil, Plus, Send, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Card, EmptyState } from "@/components/ui/misc";
import { Dialog, DialogBody, DialogClose, DialogContent, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { useConfirm } from "@/components/ui/confirm";
import { useAction } from "@/hooks/use-action";
import { deleteNotificationChannel, saveNotificationChannel, testNotificationChannel, toggleNotificationChannel } from "@/server/actions/integrations";

type Channel = { id: string; name: string; kind: string; enabled: boolean; events: string[]; config: Record<string, string> };

const kinds = {
  discord: { label: "Discord", fields: [["webhookUrl", "Webhook URL", "https://discord.com/api/webhooks/…"]] },
  slack: { label: "Slack", fields: [["webhookUrl", "Incoming webhook URL", "https://hooks.slack.com/services/…"]] },
  telegram: {
    label: "Telegram",
    fields: [
      ["botToken", "Bot token", "123456:ABC…"],
      ["chatId", "Chat ID", "-1001234567890"],
    ],
  },
  webhook: { label: "Webhook", fields: [["url", "URL", "https://example.com/hooks/serve"]] },
  email: { label: "Email", fields: [["to", "Send to", "ops@example.com, oncall@example.com"]] },
} as const;

export function NotificationChannels({ channels, events, isAdmin }: { channels: Channel[]; events: { id: string; label: string }[]; isAdmin: boolean }) {
  const confirm = useConfirm();
  const [editing, setEditing] = React.useState<Channel | null>(null);
  const [open, setOpen] = React.useState(false);
  const [form, setForm] = React.useState<{ name: string; kind: keyof typeof kinds; config: Record<string, string>; events: string[] }>({
    name: "",
    kind: "discord",
    config: {},
    events: ["deploy.failed", "service.crashed", "backup.failed", "certificate.failed"],
  });

  const openFor = (c: Channel | null) => {
    setEditing(c);
    setForm(
      c
        ? { name: c.name, kind: c.kind as keyof typeof kinds, config: c.config, events: c.events }
        : { name: "", kind: "discord", config: {}, events: ["deploy.failed", "service.crashed", "backup.failed", "certificate.failed"] },
    );
    setOpen(true);
  };
  const save = useAction(() => saveNotificationChannel(editing?.id ?? null, form), { success: "Channel saved", onSuccess: () => setOpen(false) });
  const toggle = useAction((id: string, on: boolean) => toggleNotificationChannel(id, on));
  const test = useAction(testNotificationChannel, { success: "Test sent", refresh: false });
  const remove = useAction(deleteNotificationChannel, { success: "Channel removed" });

  return (
    <div className="flex flex-col gap-4">
      <Card className="overflow-hidden">
        {channels.length > 0 && (
          <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-3.5">
            <p className="text-[13px] text-muted">
              {channels.length} channel{channels.length === 1 ? "" : "s"}
            </p>
            {isAdmin && (
              <Button size="sm" variant="primary" onClick={() => openFor(null)}>
                <Plus /> Add channel
              </Button>
            )}
          </div>
        )}
        {channels.length === 0 ? (
          <EmptyState
            icon={<Bell />}
            title="No notification channels"
            description="Send alerts to Discord, Slack, Telegram or any webhook."
            action={
              isAdmin && (
                <Button size="sm" variant="primary" onClick={() => openFor(null)}>
                  <Plus /> Add channel
                </Button>
              )
            }
          />
        ) : (
          <div className="divide-y divide-line">
            {channels.map((c) => (
              <div key={c.id} className="flex items-center gap-3 px-5 py-3.5">
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className="flex items-center gap-2 text-[14px] font-medium text-fg">
                    {c.name} <Badge>{kinds[c.kind as keyof typeof kinds]?.label ?? c.kind}</Badge>
                  </span>
                  <span className="truncate text-xs text-muted">{c.events.map((e) => events.find((x) => x.id === e)?.label ?? e).join(" · ")}</span>
                </div>
                <Button size="sm" variant="ghost" onClick={() => test.run(c.id)} loading={test.pending}>
                  <Send /> Test
                </Button>
                {isAdmin && (
                  <>
                    <Button size="icon-sm" variant="ghost" aria-label="Edit" onClick={() => openFor(c)}>
                      <Pencil />
                    </Button>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label="Remove"
                      onClick={async () => {
                        if (await confirm({ title: `Remove ${c.name}?`, confirmLabel: "Remove", danger: true })) remove.run(c.id);
                      }}
                    >
                      <Trash2 />
                    </Button>
                    <Switch checked={c.enabled} onCheckedChange={(on) => toggle.run(c.id, on)} />
                  </>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void save.run();
            }}
          >
            <DialogHeader title={editing ? "Edit channel" : "Add channel"} />
            <DialogBody>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label="Name">
                  <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required placeholder="#deploys" />
                </Field>
                <Field label="Type">
                  <Select
                    value={form.kind}
                    onValueChange={(k) => setForm({ ...form, kind: k as keyof typeof kinds, config: {} })}
                    options={Object.entries(kinds).map(([k, v]) => ({ value: k, label: v.label }))}
                  />
                </Field>
              </div>
              {kinds[form.kind].fields.map(([key, label, placeholder]) => (
                <Field key={key} label={label}>
                  <Input
                    value={form.config[key] ?? ""}
                    onChange={(e) => setForm({ ...form, config: { ...form.config, [key]: e.target.value } })}
                    placeholder={placeholder}
                    required
                    className="font-mono text-[13px]"
                  />
                </Field>
              ))}
              <Field label="Events">
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {events.map((ev) => (
                    <label key={ev.id} className="flex items-center gap-2 text-[13px] text-fg-2">
                      <Checkbox
                        checked={form.events.includes(ev.id)}
                        onCheckedChange={(c) => setForm({ ...form, events: c ? [...form.events, ev.id] : form.events.filter((x) => x !== ev.id) })}
                      />
                      {ev.label}
                    </label>
                  ))}
                </div>
              </Field>
            </DialogBody>
            <DialogFooter>
              <DialogClose render={<Button variant="ghost" size="sm" />}>Cancel</DialogClose>
              <Button type="submit" variant="primary" size="sm" loading={save.pending}>
                Save channel
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
