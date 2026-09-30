"use client";

import { Badge, TimeAgo } from "@/components/ui/misc";
import { SwitchRow } from "@/components/ui/switch";
import { SettingsCard } from "../_components/settings-card";

export function AdvancedSettings({
  orgSettings,
  organizations,
}: {
  orgSettings: { allowOrganizationCreation: boolean; domainVerification: boolean };
  organizations: { id: string; name: string; createdAt: string; members: number; projects: number; isRoot: boolean }[];
}) {
  return (
    <SettingsCard title="Organizations" description={<>Every organization on this instance.</>} initial={orgSettings}>
      {(v, set) => (
        <>
          <SwitchRow
            title="Let every user create organizations"
            description="When off, only Root admins can create them."
            checked={v.allowOrganizationCreation}
            onCheckedChange={set("allowOrganizationCreation")}
          />
          <SwitchRow
            title="Other organizations prove they own their domains"
            description="Before adding a custom domain, organizations other than Root add a DNS TXT record (or have the zone in their Cloudflare account). Keeps one organization from taking another's domain."
            checked={v.domainVerification}
            onCheckedChange={set("domainVerification")}
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
  );
}
