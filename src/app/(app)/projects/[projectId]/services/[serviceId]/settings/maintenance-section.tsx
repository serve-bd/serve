"use client";

import { ExternalLink } from "lucide-react";
import { Field } from "@/components/ui/field";
import { Input, Textarea } from "@/components/ui/input";
import { SwitchRow } from "@/components/ui/switch";
import { useAction } from "@/hooks/use-action";
import { setMaintenance } from "@/server/actions/maintenance";
import type { MaintenanceConfig } from "@/server/services/types";
import { Section } from "./section";

const DEFAULT_TITLE = "We'll be back soon";
const DEFAULT_MESSAGE = "We're doing some planned maintenance. Please check back in a few minutes.";

/** Maintenance mode: a 503 page on every domain, with an optional allow list. */
export function MaintenanceSection({ serviceId, config, domains }: { serviceId: string; config: MaintenanceConfig | null; domains: string[] }) {
  const save = useAction((v: Parameters<typeof setMaintenance>[1]) => setMaintenance(serviceId, v), {
    success: (d) => (d.enabled ? "Maintenance mode is on" : "Maintenance settings saved"),
  });
  const initial = {
    enabled: !!config?.enabled,
    title: config?.title ?? DEFAULT_TITLE,
    message: config?.message ?? DEFAULT_MESSAGE,
    allow: (config?.allow ?? []).join("\n"),
    retryAfterMinutes: String(config?.retryAfterMinutes ?? 10),
  };
  return (
    <Section
      id="maintenance"
      title="Maintenance"
      description="Show a maintenance page on every domain of this service. The app keeps running, so you can check it before visitors come back."
      initial={initial}
      onSave={(v) =>
        save.run({
          enabled: v.enabled,
          title: v.title,
          message: v.message,
          allow: v.allow
            .split(/[\s,]+/)
            .map((a) => a.trim())
            .filter(Boolean),
          retryAfterMinutes: Math.max(1, Number(v.retryAfterMinutes) || 10),
        })
      }
      footerNote={domains.length ? "Changes reach the proxy as soon as you save." : "This service has no domains yet, so there is nothing to show the page on."}
    >
      {(v, set) => (
        <>
          <SwitchRow
            title="Maintenance mode"
            description="Visitors get this page with HTTP 503 and a Retry-After header, which tells search engines the pause is temporary."
            checked={v.enabled}
            onCheckedChange={(c) => set({ enabled: c })}
          />
          <Field label="Title">
            <Input value={v.title} onChange={(e) => set({ title: e.target.value })} maxLength={120} />
          </Field>
          <Field label="Message" description="Leave an empty line between paragraphs.">
            <Textarea value={v.message} onChange={(e) => set({ message: e.target.value })} rows={3} maxLength={2000} />
          </Field>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-[minmax(0,1fr)_160px]">
            <Field label="Still reach the app" optional description="IP addresses or CIDR ranges, one per line. Use this to check the app before you turn maintenance off.">
              <Textarea value={v.allow} onChange={(e) => set({ allow: e.target.value })} rows={2} placeholder={"203.0.113.7\n10.0.0.0/8"} className="font-mono text-[13px]" />
            </Field>
            <Field label="Retry after" description="Minutes.">
              <Input value={v.retryAfterMinutes} onChange={(e) => set({ retryAfterMinutes: e.target.value.replace(/\D/g, "") })} inputMode="numeric" />
            </Field>
          </div>
          {domains.length > 0 && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
              <span>Shown on</span>
              {domains.slice(0, 6).map((d) => (
                <a key={d} href={`//${d}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-mono text-fg-2 hover:text-accent">
                  {d} <ExternalLink className="size-3" />
                </a>
              ))}
              {domains.length > 6 && <span>and {domains.length - 6} more</span>}
            </div>
          )}
        </>
      )}
    </Section>
  );
}
