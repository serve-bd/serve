"use client";

import * as React from "react";
import Link from "next/link";
import { Bell, History, MoreHorizontal, Moon, Pencil, Plus, RotateCw, Send, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardHeader, EmptyState, TimeAgo } from "@/components/ui/misc";
import { Menu, MenuContent, MenuItem, MenuLabel, MenuLinkItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useConfirm } from "@/components/ui/confirm";
import { PageBody, PageHeader } from "@/components/shell/page-header";
import { useAction } from "@/hooks/use-action";
import { eventInfo, providerCategories, providerInfo, providers, severityOptions } from "@/lib/notifications";
import { cn } from "@/lib/utils";
import { deleteNotificationChannel, retryNotificationDelivery, testNotificationChannel, toggleNotificationChannel } from "@/server/actions/notifications";
import { ProviderIcon } from "./provider-icon";

export type ChannelCard = {
  id: string;
  name: string;
  kind: string;
  enabled: boolean;
  events: string[];
  minSeverity: string;
  scoped: boolean;
  quietHours: string | null;
  throttleMinutes: number;
  lastDelivery: { at: string; status: string; error: string | null } | null;
};

export type DeliveryRow = {
  id: string;
  channelId: string;
  event: string;
  severity: string;
  title: string;
  status: string;
  error: string | null;
  attempts: number;
  nextAttemptAt: string | null;
  test: boolean;
  createdAt: string;
};

const statusTone: Record<string, { label: string; tone: "ok" | "bad" | "info" | "neutral" | "warn" }> = {
  sent: { label: "Sent", tone: "ok" },
  failed: { label: "Failed", tone: "bad" },
  pending: { label: "Sending", tone: "neutral" },
  held: { label: "Held", tone: "info" },
  suppressed: { label: "Not sent", tone: "neutral" },
  grouped: { label: "Grouped", tone: "neutral" },
};

const popular = ["slack", "discord", "email", "telegram", "teams", "ntfy", "pagerduty", "webhook"];

export function AddChannelMenu({ label = "Add channel", variant = "primary" }: { label?: string; variant?: "primary" | "secondary" }) {
  return (
    <Menu>
      <MenuTrigger render={<Button size="sm" variant={variant} />}>
        <Plus /> {label}
      </MenuTrigger>
      <MenuContent className="max-h-[70vh] w-60 overflow-y-auto">
        {providerCategories.map((cat, i) => (
          <React.Fragment key={cat}>
            {i > 0 && <MenuSeparator />}
            <MenuLabel>{cat}</MenuLabel>
            {providers
              .filter((p) => p.category === cat)
              .map((p) => (
                <MenuLinkItem key={p.id} render={<Link href={`/integrations/notifications/new/${p.id}`} />}>
                  <ProviderIcon kind={p.id} size="sm" className="[&_svg]:text-white!" />
                  {p.label}
                </MenuLinkItem>
              ))}
          </React.Fragment>
        ))}
      </MenuContent>
    </Menu>
  );
}

export function NotificationChannels({ channels, deliveries, isAdmin }: { channels: ChannelCard[]; deliveries: DeliveryRow[]; isAdmin: boolean }) {
  const confirm = useConfirm();
  const [testing, setTesting] = React.useState<string | null>(null);
  const toggle = useAction((id: string, on: boolean) => toggleNotificationChannel(id, on));
  const test = useAction((id: string) => testNotificationChannel(id), { success: "Test sent" });
  const remove = useAction(deleteNotificationChannel, { success: "Channel removed" });

  return (
    <>
      <PageHeader
        title="Notifications"
        description="Choose where Serve sends alerts, which events each place gets, and when."
        actions={isAdmin && channels.length > 0 && <AddChannelMenu />}
      />
      <PageBody className="flex flex-col gap-6">
        {channels.length === 0 ? (
          <Card>
            <EmptyState
              icon={<Bell />}
              title="No notification channels yet"
              description="Get told when a deployment fails, a site goes down or a backup breaks. Pick where to send alerts."
              action={isAdmin && <AddChannelMenu label="Choose a channel" />}
            />
            {isAdmin && (
              <div className="grid grid-cols-2 gap-2 border-t border-line p-4 sm:grid-cols-4">
                {popular.map((id) => {
                  const p = providerInfo(id)!;
                  return (
                    <Link
                      key={id}
                      href={`/integrations/notifications/new/${id}`}
                      className="flex items-center gap-2.5 rounded-xl border border-line px-3 py-2.5 text-[13px] font-medium text-fg-2 transition-colors hover:border-line-strong hover:bg-hover hover:text-fg"
                    >
                      <ProviderIcon kind={id} size="sm" />
                      <span className="truncate">{p.label}</span>
                    </Link>
                  );
                })}
              </div>
            )}
          </Card>
        ) : (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            {channels.map((c) => {
              const p = providerInfo(c.kind);
              const last = c.lastDelivery;
              return (
                <Card key={c.id} className={cn("flex flex-col transition-opacity", !c.enabled && "opacity-70")}>
                  <div className="flex items-start gap-3 p-5 pb-4">
                    <ProviderIcon kind={c.kind} />
                    <div className="min-w-0 flex-1">
                      <Link href={`/integrations/notifications/${c.id}`} className="block truncate text-[15px] font-semibold text-fg hover:underline">
                        {c.name}
                      </Link>
                      <p className="truncate text-xs text-muted">{p?.label ?? c.kind}</p>
                    </div>
                    {isAdmin ? (
                      <Switch checked={c.enabled} onCheckedChange={(on) => toggle.run(c.id, on)} aria-label={c.enabled ? "Turn off" : "Turn on"} />
                    ) : (
                      !c.enabled && <Badge>Off</Badge>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-1.5 px-5 pb-4">
                    <Badge>
                      {c.events.length} event{c.events.length === 1 ? "" : "s"}
                    </Badge>
                    <Badge>{severityOptions.find((s) => s.value === c.minSeverity)?.label ?? "Everything"}</Badge>
                    <Badge>{c.scoped ? "Some projects" : "All projects"}</Badge>
                    {c.quietHours && (
                      <Badge>
                        <Moon /> {c.quietHours}
                      </Badge>
                    )}
                    {c.throttleMinutes > 0 && <Badge>Grouped {c.throttleMinutes < 60 ? `${c.throttleMinutes} min` : `${c.throttleMinutes / 60} h`}</Badge>}
                  </div>
                  <div className="mt-auto flex items-center gap-2 border-t border-line px-5 py-3">
                    <span className="flex min-w-0 flex-1 items-center gap-2 text-xs text-muted">
                      <span className={cn("size-1.5 flex-none rounded-full", !last ? "bg-idle" : last.status === "failed" ? "bg-bad" : "bg-ok")} />
                      {last ? (
                        <span className="truncate" title={last.error ?? undefined}>
                          {last.status === "failed" ? "Last delivery failed" : "Last sent"} <TimeAgo date={last.at} />
                        </span>
                      ) : (
                        "Nothing sent yet"
                      )}
                    </span>
                    <Button
                      size="sm"
                      variant="ghost"
                      loading={testing === c.id}
                      onClick={async () => {
                        setTesting(c.id);
                        await test.run(c.id);
                        setTesting(null);
                      }}
                    >
                      <Send /> Test
                    </Button>
                    {isAdmin && (
                      <Menu>
                        <MenuTrigger render={<Button size="icon-sm" variant="ghost" aria-label="More actions" />}>
                          <MoreHorizontal />
                        </MenuTrigger>
                        <MenuContent>
                          <MenuLinkItem render={<Link href={`/integrations/notifications/${c.id}`} />}>
                            <Pencil /> Edit
                          </MenuLinkItem>
                          <MenuSeparator />
                          <MenuItem
                            danger
                            onClick={async () => {
                              if (await confirm({ title: `Remove ${c.name}?`, description: "Its delivery history is removed too.", confirmLabel: "Remove channel", danger: true }))
                                remove.run(c.id);
                            }}
                          >
                            <Trash2 /> Remove
                          </MenuItem>
                        </MenuContent>
                      </Menu>
                    )}
                  </div>
                </Card>
              );
            })}
          </div>
        )}
        {channels.length > 0 && <DeliveryHistory deliveries={deliveries} channels={channels} isAdmin={isAdmin} />}
      </PageBody>
    </>
  );
}

function DeliveryHistory({ deliveries, channels, isAdmin }: { deliveries: DeliveryRow[]; channels: ChannelCard[]; isAdmin: boolean }) {
  const [filter, setFilter] = React.useState("all");
  const [retrying, setRetrying] = React.useState<string | null>(null);
  const retry = useAction(retryNotificationDelivery, { success: "Sent" });
  const rows = deliveries.filter((d) => (filter === "all" ? true : filter === "failed" ? d.status === "failed" : d.channelId === filter));
  const byId = new Map(channels.map((c) => [c.id, c]));
  return (
    <Card>
      <CardHeader
        title="Delivery history"
        description="The last 100 notifications of this organization. History is kept for 30 days."
        actions={
          <Select
            size="sm"
            className="w-48"
            value={filter}
            onValueChange={setFilter}
            options={[
              { value: "all", label: "All deliveries" },
              { value: "failed", label: "Failed only" },
              ...channels.map((c) => ({ value: c.id, label: c.name, icon: <ProviderIcon kind={c.kind} size="sm" className="size-4 rounded [&_svg]:size-2.5" /> })),
            ]}
          />
        }
      />
      {rows.length === 0 ? (
        <EmptyState icon={<History />} title={filter === "all" ? "Nothing sent yet" : "No matching deliveries"} description="Notifications appear here as they are sent." />
      ) : (
        <ul className="divide-y divide-line">
          {rows.map((d) => {
            const channel = byId.get(d.channelId);
            const tone = statusTone[d.status] ?? statusTone.pending;
            return (
              <li key={d.id} className="flex items-start gap-3 px-5 py-3">
                {channel && <ProviderIcon kind={channel.kind} size="sm" className="mt-0.5" />}
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="min-w-0 truncate text-[13px] font-medium text-fg">{d.title}</span>
                    <Badge tone={tone.tone}>{tone.label}</Badge>
                    {d.test && <Badge>Test</Badge>}
                  </div>
                  <p className="mt-0.5 truncate text-xs text-muted">
                    {d.event === "test" ? "Test" : d.event === "digest" ? "Quiet hours summary" : (eventInfo(d.event)?.label ?? d.event)} · {channel?.name ?? "Removed channel"} ·{" "}
                    <TimeAgo date={d.createdAt} />
                    {d.attempts > 1 && ` · ${d.attempts} attempts`}
                  </p>
                  {d.error && (
                    <p className={cn("mt-1 text-xs break-words", d.status === "failed" ? "text-bad" : "text-muted")}>
                      {d.error}
                      {d.status === "failed" && d.nextAttemptAt && <span className="text-muted"> · Serve tries again automatically.</span>}
                    </p>
                  )}
                  {d.status === "held" && <p className="mt-1 text-xs text-muted">Waiting for quiet hours to end.</p>}
                </div>
                {isAdmin && d.status === "failed" && !d.test && (
                  <Button
                    size="sm"
                    variant="ghost"
                    loading={retrying === d.id}
                    onClick={async () => {
                      setRetrying(d.id);
                      await retry.run(d.id);
                      setRetrying(null);
                    }}
                  >
                    <RotateCw /> Retry
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
