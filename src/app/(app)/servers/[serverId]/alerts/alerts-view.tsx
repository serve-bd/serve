"use client";

import * as React from "react";
import Link from "next/link";
import { CircleCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardFooter, CardHeader, TimeAgo } from "@/components/ui/misc";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { SwitchRow } from "@/components/ui/switch";
import { useAction } from "@/hooks/use-action";
import { saveServerAlerts } from "@/server/actions/monitoring";
import type { ServerAlertConfig } from "@/server/db/schema";
import { cn } from "@/lib/utils";

type Incident = { id: string; title: string; detail: string | null; severity: "warning" | "critical"; startedAt: string; resolvedAt: string | null };

const num = (v: string) => Number(v.replace(/\D/g, "") || 0);

/** Resource alert thresholds of a server and its recent alerts. */
export function AlertsView({ serverId, serverName, config, incidents }: { serverId: string; serverName: string; config: ServerAlertConfig; incidents: Incident[] }) {
  const [v, setV] = React.useState(config);
  const set = (patch: Partial<ServerAlertConfig>) => setV((c) => ({ ...c, ...patch }));
  const dirty = JSON.stringify(v) !== JSON.stringify(config);
  const save = useAction(() => saveServerAlerts(serverId, v), { success: "Alerts saved" });
  const open = incidents.filter((i) => !i.resolvedAt);

  return (
    <>
      <Card>
        <CardHeader title="Current alerts" description={open.length ? `${open.length} active` : `Disk, memory and CPU on ${serverName} are within the limits.`} />
        {open.length === 0 ? (
          <CardBody className="flex items-center gap-2.5 text-[13px] text-fg-2">
            <CircleCheck className="size-4 text-ok" /> No active alerts.
          </CardBody>
        ) : (
          <div className="divide-y divide-line">
            {open.map((i) => (
              <div key={i.id} className="flex items-start gap-3 px-5 py-3">
                <span className={cn("mt-1.5 size-2 flex-none rounded-full", i.severity === "warning" ? "bg-warn" : "bg-bad")} />
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] font-medium text-fg">{i.title}</p>
                  {i.detail && <p className="text-xs leading-relaxed text-muted">{i.detail}</p>}
                </div>
                <span className="flex-none text-xs text-faint">
                  since <TimeAgo date={i.startedAt} />
                </span>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void save.run();
          }}
        >
          <CardHeader
            title="Thresholds"
            description="Serve compares the samples it collects every 30 seconds with these limits and alerts your notification channels. An alert clears 5 points below its limit."
          />
          <CardBody className="flex flex-col gap-5">
            <SwitchRow title="Resource alerts" description={`Watch disk, memory and CPU on ${serverName}.`} checked={v.enabled} onCheckedChange={(enabled) => set({ enabled })} />
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Disk warning" description="Percent used.">
                <Input value={String(v.diskWarn)} onChange={(e) => set({ diskWarn: num(e.target.value) })} inputMode="numeric" disabled={!v.enabled} />
              </Field>
              <Field label="Disk critical" description="Percent used.">
                <Input value={String(v.diskCritical)} onChange={(e) => set({ diskCritical: num(e.target.value) })} inputMode="numeric" disabled={!v.enabled} />
              </Field>
              <Field label="Memory" description="Percent used.">
                <Input value={String(v.memory)} onChange={(e) => set({ memory: num(e.target.value) })} inputMode="numeric" disabled={!v.enabled} />
              </Field>
              <Field label="CPU" description={`Percent, sustained for ${v.cpuMinutes} minutes.`}>
                <Input value={String(v.cpu)} onChange={(e) => set({ cpu: num(e.target.value) })} inputMode="numeric" disabled={!v.enabled} />
              </Field>
              <Field label="CPU duration" description="Minutes above the limit before alerting.">
                <Input value={String(v.cpuMinutes)} onChange={(e) => set({ cpuMinutes: num(e.target.value) })} inputMode="numeric" disabled={!v.enabled} />
              </Field>
            </div>
            <p className="text-xs text-muted">
              Choose where alerts go in{" "}
              <Link href="/integrations/notifications" className="text-accent hover:underline">
                Notifications
              </Link>{" "}
              (event “Server CPU, memory or disk high”).
            </p>
          </CardBody>
          <CardFooter className="justify-end">
            <Button type="submit" variant="primary" size="sm" disabled={!dirty} loading={save.pending}>
              Save
            </Button>
          </CardFooter>
        </form>
      </Card>

      {incidents.some((i) => i.resolvedAt) && (
        <Card>
          <CardHeader title="Past alerts" />
          <div className="divide-y divide-line">
            {incidents
              .filter((i) => i.resolvedAt)
              .map((i) => (
                <div key={i.id} className="flex items-center gap-3 px-5 py-2.5 text-[13px]">
                  <span className="size-1.5 flex-none rounded-full bg-idle" />
                  <span className="min-w-0 flex-1 truncate text-fg-2">{i.title}</span>
                  <span className="flex-none text-xs text-faint">
                    <TimeAgo date={i.startedAt} />
                  </span>
                </div>
              ))}
          </div>
        </Card>
      )}
    </>
  );
}
