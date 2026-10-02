"use client";

import * as React from "react";
import { CircleCheck, Info, Rocket } from "lucide-react";
import { useRouter } from "@/hooks/use-router";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogClose, DialogContent, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { SwitchRow } from "@/components/ui/switch";
import { ServiceIcon } from "@/components/service-icon";
import { useAction } from "@/hooks/use-action";
import { useCan } from "@/components/permissions";
import { cloneEnvironmentAction, deployEnvironment } from "@/server/actions/environments";
import type { CloneSummary } from "@/server/services/environments";

/** Copy an environment into a new one, then show what was copied with a "Deploy all" button. */
export function CloneEnvironmentDialog({
  projectId,
  environment,
  open,
  onOpenChange,
}: {
  projectId: string;
  environment: { id: string; name: string };
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const can = useCan();
  const [name, setName] = React.useState("");
  const [generatedDomains, setGeneratedDomains] = React.useState(true);
  const [copyData, setCopyData] = React.useState(false);
  const [summary, setSummary] = React.useState<(CloneSummary & { name: string }) | null>(null);
  const clone = useAction(() => cloneEnvironmentAction(environment.id, { name, generatedDomains, copyData }), {
    onSuccess: (s) => setSummary({ ...s, name: name.trim().toLowerCase() }),
  });
  const deployAll = useAction((id: string) => deployEnvironment(id), {
    onSuccess: () => {
      if (summary) router.push(`/projects/${projectId}?env=${summary.name}`);
      close(false);
    },
  });

  function close(next: boolean) {
    onOpenChange(next);
    if (!next) {
      // Reset after the closing animation.
      setTimeout(() => {
        setSummary(null);
        setName("");
        setCopyData(false);
        setGeneratedDomains(true);
      }, 200);
    }
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent size="md">
        {summary ? (
          <>
            <DialogHeader title={`${summary.name} is ready`} description={`Copied from ${environment.name}. Nothing is deployed yet.`} />
            <DialogBody className="flex flex-col gap-4">
              <div className="grid grid-cols-3 gap-px overflow-hidden rounded-xl border border-line bg-line text-center">
                <Figure value={summary.services.length} label={summary.services.length === 1 ? "service" : "services"} />
                <Figure value={summary.variables + summary.sharedVariables} label="variables" />
                <Figure value={summary.domains} label={summary.domains === 1 ? "domain" : "domains"} />
              </div>
              {summary.services.length > 0 && (
                <ul className="flex max-h-48 flex-col divide-y divide-line overflow-y-auto rounded-xl border border-line">
                  {summary.services.map((s) => (
                    <li key={s.id} className="flex items-center gap-3 px-3 py-2 text-[13px]">
                      <ServiceIcon type={s.type} size="sm" />
                      <span className="min-w-0 flex-1 truncate text-fg">{s.name}</span>
                      <CircleCheck className="size-4 flex-none text-ok" />
                    </li>
                  ))}
                </ul>
              )}
              {(summary.copyingData || summary.notes.length > 0) && (
                <ul className="flex flex-col gap-1.5 text-[13px] text-fg-2">
                  {summary.copyingData && <Note>Database data is being copied now. The new databases start on their own for that; see Activity for progress.</Note>}
                  {summary.notes.map((n) => (
                    <Note key={n}>{n}</Note>
                  ))}
                </ul>
              )}
            </DialogBody>
            <DialogFooter>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  router.push(`/projects/${projectId}?env=${summary.name}`);
                  close(false);
                }}
              >
                Open {summary.name}
              </Button>
              {can("services.deploy") && (
                <Button variant="primary" size="sm" onClick={() => deployAll.run(summary.environmentId)} loading={deployAll.pending} disabled={!summary.services.length}>
                  <Rocket /> Deploy all
                </Button>
              )}
            </DialogFooter>
          </>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              clone.run();
            }}
          >
            <DialogHeader
              title={`Clone ${environment.name}`}
              description="Creates a new environment with a copy of every service, with its settings and variables. Nothing is deployed until you choose to."
            />
            <DialogBody className="flex flex-col gap-4">
              <Field label="New environment name" description="References between services, like ${{postgres.DATABASE_URL}}, point at the copies.">
                <Input value={name} onChange={(e) => setName(e.target.value)} required autoFocus placeholder="staging" pattern="[a-z0-9][a-z0-9-]*" />
              </Field>
              <SwitchRow
                title="Generated domains"
                description="Give apps that had a generated domain a new one. Custom domains always stay with the original."
                checked={generatedDomains}
                onCheckedChange={setGeneratedDomains}
              />
              <SwitchRow
                title="Copy database data"
                description="Dump each database and restore it into its copy. This starts the new databases. Other volumes start empty."
                checked={copyData}
                onCheckedChange={setCopyData}
              />
            </DialogBody>
            <DialogFooter>
              <DialogClose render={<Button variant="ghost" size="sm" />}>Cancel</DialogClose>
              <Button type="submit" variant="primary" size="sm" loading={clone.pending}>
                Clone environment
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Figure({ value, label }: { value: number; label: string }) {
  return (
    <div className="flex flex-col bg-surface px-3 py-2.5">
      <span className="text-[18px] font-semibold text-fg tabular-nums">{value}</span>
      <span className="text-xs text-muted">{label}</span>
    </div>
  );
}

function Note({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2">
      <Info className="mt-0.5 size-3.5 flex-none text-muted" />
      <span>{children}</span>
    </li>
  );
}
