"use client";

import Link from "next/link";
import { Play, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { useConfirm } from "@/components/ui/confirm";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { SwitchRow } from "@/components/ui/switch";
import { toast } from "@/components/ui/toast";
import { useAction, showError } from "@/hooks/use-action";
import { checkMonitorNow, deleteRequestLog, saveMonitor, saveRequestLog } from "@/server/actions/monitoring";
import type { MonitorSummary } from "@/server/monitoring/queries";
import type { RequestLogConfig } from "@/server/services/types";
import { Section } from "./section";

const intervals = [
  { value: "30", label: "Every 30 seconds" },
  { value: "60", label: "Every minute" },
  { value: "120", label: "Every 2 minutes" },
  { value: "300", label: "Every 5 minutes" },
  { value: "600", label: "Every 10 minutes" },
];

/** Uptime check of a service: what to check, how often, and when it counts as down. */
export function MonitoringSection({
  serviceId,
  type,
  monitor,
  defaultUrl,
}: {
  serviceId: string;
  type: string;
  monitor: MonitorSummary["monitor"];
  /** Primary domain the check uses without a URL of its own. */
  defaultUrl: string | null;
}) {
  const save = useAction((v: Parameters<typeof saveMonitor>[1]) => saveMonitor(serviceId, v));
  const check = useAction(() => checkMonitorNow(serviceId), {
    refresh: true,
    onSuccess: (r) => (r.ok ? toast.success("Check passed", r.latencyMs !== null ? `${r.latencyMs} ms` : undefined) : showError("Check failed", r.error ?? undefined)),
  });
  // Databases and services without a domain are checked through their containers.
  const defaultKind = type === "database" || !defaultUrl ? "container" : "http";
  const initial = {
    // Off until someone turns it on, so switching it on is a change Save can send.
    enabled: monitor?.enabled ?? false,
    kind: (monitor?.kind ?? defaultKind) as string,
    url: monitor?.url ?? "",
    path: monitor?.path ?? "/",
    expectedStatus: monitor?.expectedStatus ?? "200-399",
    keyword: monitor?.keyword ?? "",
    intervalSeconds: String(monitor?.intervalSeconds ?? 60),
    timeoutSeconds: String((monitor?.timeoutMs ?? 10_000) / 1000),
    failureThreshold: String(monitor?.failureThreshold ?? 3),
  };
  return (
    <Section
      id="monitoring"
      title="Monitoring"
      description={<>This service is checked, and your notification channels are alerted when it goes down and when it recovers.</>}
      initial={initial}
      onSave={(v) =>
        save.run({
          enabled: v.enabled,
          kind: v.kind as "http" | "container",
          url: v.url.trim() || null,
          path: v.path.trim() || "/",
          expectedStatus: v.expectedStatus.trim(),
          keyword: v.keyword.trim() || null,
          intervalSeconds: Number(v.intervalSeconds),
          timeoutMs: Math.round(Number(v.timeoutSeconds) * 1000),
          failureThreshold: Number(v.failureThreshold),
        })
      }
      footerAction={() =>
        monitor && (
          <Button type="button" size="sm" variant="ghost" onClick={() => check.run()} loading={check.pending}>
            <Play /> Check now
          </Button>
        )
      }
      footerNote={monitor ? undefined : "Nothing is checked until you turn it on and save."}
    >
      {(v, set) => (
        <>
          <SwitchRow title="Check this service" description="Paused checks keep their history." checked={v.enabled} onCheckedChange={(c) => set({ enabled: c })} />
          <Field label="Check">
            <Select
              value={v.kind}
              onValueChange={(kind) => set({ kind })}
              options={[
                { value: "http", label: "HTTP request", description: "Loads a URL and checks the status code, like a visitor." },
                { value: "container", label: "Containers", description: "All containers run and their health checks pass." },
              ]}
            />
          </Field>
          {v.kind === "http" && (
            <>
              <Field label="URL" optional description={defaultUrl ? `Empty checks the primary domain: ${defaultUrl}` : "This service has no domain; enter the URL to check."}>
                <Input value={v.url} onChange={(e) => set({ url: e.target.value })} placeholder={defaultUrl ?? "https://example.com/health"} className="font-mono text-[13px]" />
              </Field>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label="Path" description="Used with the primary domain.">
                  <Input value={v.path} onChange={(e) => set({ path: e.target.value })} placeholder="/" className="font-mono text-[13px]" disabled={!!v.url.trim()} />
                </Field>
                <Field label="Accepted status codes" description="Like 200-399, 200,204 or 2xx.">
                  <Input value={v.expectedStatus} onChange={(e) => set({ expectedStatus: e.target.value })} className="font-mono text-[13px]" />
                </Field>
              </div>
              <Field label="Response must contain" optional description="Fails the check when this text is missing from the page.">
                <Input value={v.keyword} onChange={(e) => set({ keyword: e.target.value })} placeholder="OK" />
              </Field>
            </>
          )}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Field label="Interval">
              <Select value={v.intervalSeconds} onValueChange={(intervalSeconds) => set({ intervalSeconds })} options={intervals} />
            </Field>
            <Field label="Timeout" description="Seconds.">
              <Input value={v.timeoutSeconds} onChange={(e) => set({ timeoutSeconds: e.target.value.replace(/[^\d.]/g, "") })} inputMode="decimal" />
            </Field>
            <Field label="Down after" description="Failed checks in a row.">
              <Input value={v.failureThreshold} onChange={(e) => set({ failureThreshold: e.target.value.replace(/\D/g, "") })} inputMode="numeric" />
            </Field>
          </div>
        </>
      )}
    </Section>
  );
}

const groups = [
  { value: 2, label: "2xx", description: "Success" },
  { value: 3, label: "3xx", description: "Redirects" },
  { value: 4, label: "4xx", description: "Client errors, like 404" },
  { value: 5, label: "5xx", description: "Server errors" },
] as const;

/** The request log: single requests through the proxy, which kinds to keep and for how long. */
export function RequestLogSection({
  serviceId,
  config,
  kept,
  hasDomains,
  metricsHref,
}: {
  serviceId: string;
  config: RequestLogConfig;
  /** Requests kept now. */
  kept: number;
  hasDomains: boolean;
  metricsHref: string;
}) {
  const confirm = useConfirm();
  const save = useAction((v: RequestLogConfig) => saveRequestLog(serviceId, v), { refresh: true });
  const clear = useAction(() => deleteRequestLog(serviceId), { refresh: true });
  const initial = { ...config, days: String(config.days) };
  return (
    <Section
      id="request-log"
      title="Request log"
      description={
        <>
          Keeps each request through the proxy: time, path, status, response time and which server answered. See them in{" "}
          <Link href={metricsHref} className="text-accent hover:underline">
            Metrics
          </Link>
          .
        </>
      }
      initial={initial}
      onSave={(v) => save.run({ enabled: v.enabled, days: Number(v.days) || 1, statuses: v.statuses, ips: v.ips })}
      footerAction={() =>
        kept > 0 && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            loading={clear.pending}
            onClick={async () => {
              const ok = await confirm({
                title: "Delete the request log?",
                description: `All ${kept.toLocaleString()} kept requests of this service are deleted. The request counts in Metrics stay.`,
                confirmLabel: "Delete",
                danger: true,
              });
              if (ok) clear.run();
            }}
          >
            <Trash2 /> Delete {kept.toLocaleString()} requests
          </Button>
        )
      }
      footerNote={hasDomains ? undefined : "This service has no domain yet, so no requests reach it through the proxy."}
    >
      {(v, set) => (
        <>
          <SwitchRow
            title="Keep a request log"
            description="Off: requests are only counted. A busy service can keep millions of requests, so choose what to keep."
            checked={v.enabled}
            onCheckedChange={(c) => set({ enabled: c })}
          />
          <Field label="Keep" description="Other responses are still counted in Metrics.">
            <div className="flex flex-wrap gap-x-5 gap-y-2">
              {groups.map((g) => (
                <label key={g.value} className="flex items-center gap-2.5 text-[13px] text-fg-2">
                  <Checkbox
                    checked={v.statuses.includes(g.value)}
                    onCheckedChange={(c) => set({ statuses: c ? [...v.statuses, g.value].sort() : v.statuses.filter((s) => s !== g.value) })}
                    disabled={!v.enabled}
                  />
                  <span className="font-mono text-fg">{g.label}</span>
                  <span className="text-muted">{g.description}</span>
                </label>
              ))}
            </div>
          </Field>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Keep for" description="Days. Older requests are deleted every hour.">
              <Input value={v.days} onChange={(e) => set({ days: e.target.value.replace(/\D/g, "") })} inputMode="numeric" disabled={!v.enabled} />
            </Field>
          </div>
          <SwitchRow
            title="Keep visitor IP addresses"
            description="Off also removes the IP addresses already kept."
            checked={v.ips}
            onCheckedChange={(c) => set({ ips: c })}
            disabled={!v.enabled}
          />
        </>
      )}
    </Section>
  );
}
