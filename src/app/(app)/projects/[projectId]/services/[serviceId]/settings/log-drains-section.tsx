"use client";

import * as React from "react";
import Link from "next/link";
import { Plus, ScrollText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/misc";
import { Switch } from "@/components/ui/switch";
import { useAction } from "@/hooks/use-action";
import { setServiceLogDrain } from "@/server/actions/log-drains";
import { DrainDialog, type DrainItem, type DrainProject } from "@/app/(app)/integrations/log-drains/log-drains";

/** A service's settings: which of the organization's log drains get its logs. */
export function LogDrainsSection({
  serviceId,
  projectId,
  drains,
  projects,
  canManage,
}: {
  serviceId: string;
  projectId: string;
  drains: DrainItem[];
  projects: DrainProject[];
  canManage: boolean;
}) {
  const [adding, setAdding] = React.useState(false);
  const toggle = useAction(setServiceLogDrain);
  return (
    <Card id="log-drains" className="scroll-mt-6">
      <CardHeader
        title="Log drains"
        description="Send this service's logs to your log service as they are written."
        actions={
          canManage && (
            <Button size="sm" onClick={() => setAdding(true)}>
              <Plus /> Add log drain
            </Button>
          )
        }
      />
      {drains.length === 0 ? (
        <CardBody>
          <p className="flex items-center gap-2 text-[13px] text-muted">
            <ScrollText className="size-4" /> No log drains yet. {canManage ? "Add one to send this service's logs." : "Someone who manages integrations can add one."}
          </p>
        </CardBody>
      ) : (
        <div className="divide-y divide-line border-t border-line">
          {drains.map((d) => {
            const viaProject = !!d.projectIds?.includes(projectId);
            const on = d.enabled && (viaProject || !!d.serviceIds?.includes(serviceId));
            // Covered by the drain's own scope: changed on the drain, not per service.
            const fixed = viaProject;
            return (
              <div key={d.id} className="flex items-center gap-4 px-5 py-3.5">
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate text-[13px] font-medium text-fg">{d.name}</span>
                  <span className="text-xs text-muted">
                    {!d.enabled ? "Paused for every service" : viaProject ? "Sends this whole project" : on ? "Sends this service" : "Not sending this service"}
                    {fixed && d.enabled && canManage && (
                      <>
                        {" · "}
                        <Link href="/integrations/log-drains" className="text-accent hover:underline">
                          Change on the drain
                        </Link>
                      </>
                    )}
                  </span>
                </div>
                <Switch
                  checked={on}
                  disabled={!canManage || fixed || !d.enabled || toggle.pending}
                  onCheckedChange={(next) => void toggle.run(d.id, serviceId, next)}
                  aria-label={`Send to ${d.name}`}
                />
              </div>
            );
          })}
        </div>
      )}
      {adding && <DrainDialog drain={null} projects={projects} preset={{ serviceIds: [serviceId] }} onClose={() => setAdding(false)} />}
    </Card>
  );
}
