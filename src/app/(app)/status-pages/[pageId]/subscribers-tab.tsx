"use client";

import * as React from "react";
import Link from "next/link";
import { Bell, Mail, Rss, Trash2, Webhook } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { useConfirm } from "@/components/ui/confirm";
import { Input } from "@/components/ui/input";
import { Badge, Card, CardHeader, EmptyState } from "@/components/ui/misc";
import { Select } from "@/components/ui/select";
import { SwitchRow } from "@/components/ui/switch";
import { useAction } from "@/hooks/use-action";
import { listStatusSubscribers, removeStatusSubscriber, saveStatusSubscriptions } from "@/server/actions/status-pages";
import type { EditorData } from "@/server/status-pages/admin";
import type { SubscribeConfig, SubscriberKind } from "@/lib/status-page";

const KIND_LABEL: Record<SubscriberKind, string> = { email: "Email", slack: "Slack", discord: "Discord", webhook: "Webhook" };

export function SubscribersTab({ data, canManage }: { data: EditorData; canManage: boolean }) {
  return (
    <div className="flex flex-col gap-5">
      <OptionsCard data={data} canManage={canManage} />
      <SubscriberList data={data} canManage={canManage} />
    </div>
  );
}

function OptionsCard({ data, canManage }: { data: EditorData; canManage: boolean }) {
  const [cfg, setCfg] = React.useState<SubscribeConfig>(data.subscribe);
  const [channels, setChannels] = React.useState<string[]>(data.teamChannelIds);
  React.useEffect(() => {
    setCfg(data.subscribe);
    setChannels(data.teamChannelIds);
  }, [data.subscribe, data.teamChannelIds]);
  const set = (key: keyof SubscribeConfig, value: boolean) => setCfg((c) => ({ ...c, [key]: value }));
  const save = useAction(() => saveStatusSubscriptions(data.page.id, { subscribe: cfg, teamChannelIds: channels }));
  const dirty = JSON.stringify(cfg) !== JSON.stringify(data.subscribe) || JSON.stringify([...channels].sort()) !== JSON.stringify([...data.teamChannelIds].sort());
  const notPublic = data.page.visibility !== "public";

  return (
    <Card>
      <CardHeader title="Ways to subscribe" description="Visitors see a Subscribe button with the ways you turn on here." />
      <div className="flex flex-col gap-3 px-5 py-4">
        {notPublic && (
          <p className="rounded-lg bg-warn-soft px-3 py-2 text-[13px] text-warn">
            Only a public page offers email and webhooks: they would get the incidents without the page's password. RSS still works for visitors who unlocked the page.
          </p>
        )}
        <SwitchRow
          title="Email"
          description={
            data.emailReady ? (
              "Visitors confirm their address with a link first. Every email has a link to unsubscribe."
            ) : (
              <>
                Set up email in{" "}
                <Link href="/settings/email" className="text-accent hover:underline">
                  Settings → Email
                </Link>{" "}
                first: Serve sends the emails with it.
              </>
            )
          }
          // Without email settings nothing could be sent: off and locked until they are set.
          checked={cfg.email && data.emailReady}
          onCheckedChange={(v) => set("email", v)}
          disabled={!canManage || !data.emailReady}
        />
        <SwitchRow
          title="Slack"
          description="Visitors paste a Slack incoming webhook URL. Serve sends a test message before saving it."
          checked={cfg.slack}
          onCheckedChange={(v) => set("slack", v)}
          disabled={!canManage}
        />
        <SwitchRow
          title="Discord"
          description="Visitors paste a Discord channel webhook URL."
          checked={cfg.discord}
          onCheckedChange={(v) => set("discord", v)}
          disabled={!canManage}
        />
        <SwitchRow
          title="Webhook"
          description="Any https URL gets a JSON message for each post: for scripts and other tools. Addresses in private networks are refused."
          checked={cfg.webhook}
          onCheckedChange={(v) => set("webhook", v)}
          disabled={!canManage}
        />
        <SwitchRow title="RSS" description="The feed link in the dialog and the footer." checked={cfg.rss} onCheckedChange={(v) => set("rss", v)} disabled={!canManage} />
        <div className="my-1 h-px bg-line" />
        <SwitchRow
          title="Let subscribers pick components"
          description="They get only the posts about the components they pick (or all, when they pick none)."
          checked={cfg.components}
          onCheckedChange={(v) => set("components", v)}
          disabled={!canManage}
        />
        <SwitchRow
          title="Send outages found by checks"
          description={
            data.design.autoIncidents
              ? "When an uptime check finds a component down, and when it is back, subscribers hear it too. Outages during planned maintenance are not sent."
              : "Turn on Show outages found by checks in Design → History first."
          }
          checked={cfg.outages}
          onCheckedChange={(v) => set("outages", v)}
          disabled={!canManage || !data.design.autoIncidents}
        />
      </div>
      <CardHeader className="border-t" title="Post to your team" description="Every incident, update and maintenance posted here also goes to these notification channels." />
      <div className="flex flex-col gap-2 px-5 py-4">
        {data.channels.length === 0 ? (
          <p className="text-[13px] text-muted">
            No notification channels yet. Add one in{" "}
            <Link href="/integrations/notifications" className="text-accent hover:underline">
              Integrations → Notifications
            </Link>
            .
          </p>
        ) : (
          data.channels.map((c) => (
            <label key={c.id} className="flex items-center gap-2.5 text-[13px] text-fg-2">
              <Checkbox
                checked={channels.includes(c.id)}
                onCheckedChange={(on) => setChannels((list) => (on ? [...list, c.id] : list.filter((x) => x !== c.id)))}
                disabled={!canManage}
              />
              <span className="truncate">{c.name}</span>
              <span className="text-xs text-muted">{c.kind}</span>
              {!c.enabled && <Badge>Off</Badge>}
            </label>
          ))
        )}
      </div>
      {canManage && (
        <div className="flex justify-end border-t border-line px-5 py-3">
          <Button size="sm" variant="primary" disabled={!dirty} loading={save.pending} onClick={() => save.run()}>
            Save
          </Button>
        </div>
      )}
    </Card>
  );
}

function SubscriberList({ data, canManage }: { data: EditorData; canManage: boolean }) {
  const confirm = useConfirm();
  const names = new Map(data.components.map((c) => [c.id, c.name]));
  const counts = data.subscriberCounts;
  const total = counts.confirmed + counts.pending;
  const [q, setQ] = React.useState("");
  const [kind, setKind] = React.useState<string>("all");
  // The first page comes with the page; search and "Show more" ask the server.
  const [list, setList] = React.useState(data.subscribers);
  React.useEffect(() => setList(data.subscribers), [data.subscribers]);
  const filtered = !!q.trim() || kind !== "all";
  const search = useAction((offset: number) => listStatusSubscribers(data.page.id, { q: q.trim() || undefined, kind: kind === "all" ? undefined : kind, offset }), {
    refresh: false,
    onSuccess: (r) => setList((prev) => (r && prevOffset.current ? { hasMore: r.hasMore, rows: [...prev.rows, ...r.rows] } : r)),
  });
  const prevOffset = React.useRef(0);
  const load = (offset: number) => {
    prevOffset.current = offset;
    void search.run(offset);
  };
  // A new search after a short pause in typing.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a search runs when the words or the type change; load reads them itself
  React.useEffect(() => {
    if (!filtered) {
      setList(data.subscribers);
      return;
    }
    const t = setTimeout(() => load(0), 300);
    return () => clearTimeout(t);
  }, [q, kind]);
  const remove = useAction((id: string) => removeStatusSubscriber(id), { onSuccess: () => filtered && load(0) });
  const byKind = Object.entries(counts.byKind)
    .map(([k, n]) => `${n} ${KIND_LABEL[k as SubscriberKind] ?? k}`)
    .join(" · ");

  return (
    <Card>
      <CardHeader
        title="Subscribers"
        description={
          total ? `${counts.confirmed} subscribed${byKind ? ` (${byKind})` : ""}${counts.pending ? `, ${counts.pending} waiting to confirm their email` : ""}.` : undefined
        }
      />
      {total === 0 ? (
        <EmptyState
          icon={data.subscribe.rss && !data.subscribe.email ? <Rss /> : <Bell />}
          title="No subscribers yet"
          description="Turn on a way to subscribe above. Visitors then find a Subscribe button on the page."
        />
      ) : (
        <>
          {total > 10 && (
            <div className="flex flex-wrap items-center gap-2 border-b border-line px-5 py-3">
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search email addresses" className="max-w-xs" aria-label="Search subscribers" />
              <Select
                size="sm"
                value={kind}
                onValueChange={setKind}
                className="w-36"
                options={[{ value: "all", label: "Every type" }, ...(["email", "slack", "discord", "webhook"] as const).map((k) => ({ value: k, label: KIND_LABEL[k] }))]}
              />
            </div>
          )}
          {list.rows.length === 0 ? (
            <p className="px-5 py-6 text-center text-[13px] text-muted">No subscriber matches.</p>
          ) : (
            <div className="divide-y divide-line">
              {list.rows.map((s) => (
                <div key={s.id} className="flex items-center gap-3 px-5 py-2.5">
                  <span className="flex-none text-muted">{s.kind === "email" ? <Mail className="size-4" /> : <Webhook className="size-4" />}</span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13px] font-medium text-fg">{s.target}</p>
                    <p className="truncate text-xs text-muted">
                      {KIND_LABEL[s.kind]}
                      {s.componentIds.length ? ` · ${s.componentIds.map((id) => names.get(id) ?? "removed").join(", ")}` : " · every component"}
                      {s.lastError && <span className="text-bad"> · last send failed: {s.lastError}</span>}
                    </p>
                  </div>
                  {!s.confirmed && <Badge tone="warn">Not confirmed</Badge>}
                  {canManage && (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Remove ${s.target}`}
                      onClick={async () => {
                        if (
                          await confirm({
                            title: `Remove ${s.target}?`,
                            description: "It gets no more updates. The visitor can subscribe again.",
                            confirmLabel: "Remove",
                            danger: true,
                          })
                        )
                          void remove.run(s.id);
                      }}
                    >
                      <Trash2 />
                    </Button>
                  )}
                </div>
              ))}
            </div>
          )}
          {list.hasMore && (
            <div className="border-t border-line px-5 py-3 text-center">
              <Button size="sm" variant="ghost" loading={search.pending} onClick={() => load(list.rows.length)}>
                Show more
              </Button>
            </div>
          )}
        </>
      )}
    </Card>
  );
}
