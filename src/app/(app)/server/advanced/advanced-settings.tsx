"use client";

import { Badge, TimeAgo } from "@/components/ui/misc";
import { Field } from "@/components/ui/field";
import { Input, InputGroup } from "@/components/ui/input";
import { SwitchRow } from "@/components/ui/switch";
import { SettingsCard } from "../_components/settings-card";

const digits = (value: string, fallback = 1) => Number(value.replace(/\D/g, "")) || fallback;

export function AdvancedSettings({
  limits,
  orgSettings,
  organizations,
}: {
  limits: { buildConcurrency: number; imageRetention: number; metricsRetentionHours: number; proxyMaxBodySize: string };
  orgSettings: { allowOrganizationCreation: boolean };
  organizations: { id: string; name: string; createdAt: string; members: number; projects: number; isRoot: boolean }[];
}) {
  return (
    <>
      <SettingsCard title="Builds and limits" description="Resources Serve itself may use." initial={limits}>
        {(v, set) => (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Concurrent builds" description="More builds at once need more CPU and memory.">
              <Input value={String(v.buildConcurrency)} onChange={(e) => set("buildConcurrency")(digits(e.target.value))} inputMode="numeric" />
            </Field>
            <Field label="Images kept per service" description="Older images are removed. Each one allows an instant rollback.">
              <Input value={String(v.imageRetention)} onChange={(e) => set("imageRetention")(digits(e.target.value))} inputMode="numeric" />
            </Field>
            <Field label="Metrics history" description="How long CPU, memory and request metrics are kept.">
              <InputGroup suffix="hours">
                <Input value={String(v.metricsRetentionHours)} onChange={(e) => set("metricsRetentionHours")(digits(e.target.value))} inputMode="numeric" />
              </InputGroup>
            </Field>
            <Field label="Max upload size" description="Largest request body the proxy accepts, like 100m or 1g.">
              <Input value={v.proxyMaxBodySize} onChange={(e) => set("proxyMaxBodySize")(e.target.value)} className="font-mono" />
            </Field>
          </div>
        )}
      </SettingsCard>

      <SettingsCard title="Organizations" description="Every organization on this server." initial={orgSettings}>
        {(v, set) => (
          <>
            <SwitchRow
              title="Let every user create organizations"
              description="When off, only Root admins can create them."
              checked={v.allowOrganizationCreation}
              onCheckedChange={set("allowOrganizationCreation")}
            />
            <div className="divide-y divide-line rounded-xl border border-line">
              {organizations.map((o) => (
                <div key={o.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-[13px]">
                  <span className="flex min-w-0 flex-1 items-center gap-2">
                    <span className="truncate font-medium text-fg">{o.name}</span>
                    {o.isRoot && <Badge tone="accent">Root</Badge>}
                  </span>
                  <span className="text-muted">
                    {o.members} member{o.members === 1 ? "" : "s"} · {o.projects} project{o.projects === 1 ? "" : "s"}
                  </span>
                  <span className="text-faint">
                    <TimeAgo date={o.createdAt} />
                  </span>
                </div>
              ))}
            </div>
          </>
        )}
      </SettingsCard>
    </>
  );
}
