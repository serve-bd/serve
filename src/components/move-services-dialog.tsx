"use client";

import * as React from "react";
import useSWR from "swr";
import { AlertTriangle, ArrowRight, Link2Off, Loader2, MoveRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogBody, DialogClose, DialogContent, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Select } from "@/components/ui/select";
import { toast } from "@/components/ui/toast";
import { useRouter } from "@/hooks/use-router";
import { moveServicesTo, moveTargets, planServiceMove } from "@/server/actions/move";

type Plan = Extract<Awaited<ReturnType<typeof planServiceMove>>, { ok: true }>["data"];

/**
 * Move services to another project or environment: pick where, see what changes (renames,
 * references that stop working, services worth moving along), then move.
 */
export function MoveServicesDialog({
  serviceIds,
  environmentId,
  open,
  onOpenChange,
}: {
  serviceIds: string[];
  /** Where the services are now, left out of the choices. */
  environmentId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const { data: projects } = useSWR(open ? "move-targets" : null, async () => {
    const res = await moveTargets();
    if (!res.ok) throw new Error(res.error);
    return res.data;
  });
  const [projectId, setProjectId] = React.useState("");
  const [targetEnv, setTargetEnv] = React.useState("");
  const [extra, setExtra] = React.useState<string[]>([]);
  const [pending, setPending] = React.useState(false);
  const ids = React.useMemo(() => [...new Set([...serviceIds, ...extra])], [serviceIds, extra]);

  const project = projects?.find((p) => p.id === projectId);
  const envChoices = (project?.environments ?? []).filter((e) => e.id !== environmentId);
  const chooseProject = React.useCallback(
    (id: string) => {
      setProjectId(id);
      setTargetEnv(projects?.find((p) => p.id === id)?.environments.find((e) => e.id !== environmentId)?.id ?? "");
    },
    [projects, environmentId],
  );

  React.useEffect(() => {
    if (!open) {
      // Choose again on the next open: the services and their environment may differ by then.
      setExtra([]);
      setProjectId("");
      setTargetEnv("");
      return;
    }
    if (!projects || projectId) return;
    // Start on another project when there is one, else another environment of this one.
    const other = projects.find((p) => p.environments.some((e) => e.id !== environmentId));
    if (other) chooseProject(other.id);
  }, [open, projects, projectId, environmentId, chooseProject]);

  const { data: plan, isLoading } = useSWR(open && targetEnv ? ["move-plan", targetEnv, ids.join(",")] : null, async () => {
    const res = await planServiceMove(ids, targetEnv);
    if (!res.ok) throw new Error(res.error);
    return res.data as Plan;
  });

  const move = async () => {
    setPending(true);
    const res = await moveServicesTo(ids, targetEnv).finally(() => setPending(false));
    if (!res.ok) return toast.error("Could not move", res.error);
    onOpenChange(false);
    const moved = `${res.data.moved} service${res.data.moved === 1 ? "" : "s"} moved`;
    if (res.data.warnings.length) toast.warning(moved, res.data.warnings.join(" "));
    else toast.success(moved);
    router.push(`/projects/${res.data.projectId}?env=${encodeURIComponent(res.data.environmentName)}`);
    router.refresh();
  };

  const broken = plan?.broken ?? [];
  const renamed = plan?.services.filter((s) => s.newName !== s.name || s.notes.length) ?? [];
  const count = plan?.services.length ?? ids.length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <DialogHeader
          title={serviceIds.length === 1 ? "Move service" : `Move ${serviceIds.length} services`}
          description="Domains, volumes, backups and deployments move along. Running containers switch to the new environment's private network without a redeploy."
        />
        <DialogBody className="max-h-[65vh] gap-5 overflow-y-auto [&>*]:shrink-0">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Project">
              <Select
                value={projectId}
                onValueChange={chooseProject}
                placeholder={projects ? "Choose a project" : "Loading…"}
                options={(projects ?? []).map((p) => ({ value: p.id, label: p.name }))}
              />
            </Field>
            <Field label="Environment">
              <Select
                value={targetEnv}
                onValueChange={setTargetEnv}
                disabled={!envChoices.length}
                placeholder={project && !envChoices.length ? "No other environment" : "Choose"}
                options={envChoices.map((e) => ({ value: e.id, label: e.name }))}
              />
            </Field>
          </div>

          {!targetEnv ? null : isLoading || !plan ? (
            <p className="flex items-center gap-2 text-[13px] text-muted">
              <Loader2 className="size-4 animate-spin" /> Checking what changes…
            </p>
          ) : (
            <>
              {plan.blockers.length > 0 && (
                <div className="flex flex-col gap-1 rounded-xl border border-bad/25 bg-bad-soft px-3.5 py-3 text-[13px] text-fg-2">
                  {plan.blockers.map((b) => (
                    <p key={b} className="flex items-start gap-2">
                      <AlertTriangle className="mt-0.5 size-4 flex-none text-bad" /> {b}
                    </p>
                  ))}
                </div>
              )}

              <section className="flex flex-col gap-2">
                <h3 className="text-[12px] font-medium tracking-wide text-faint uppercase">
                  {count} service{count === 1 ? "" : "s"} to {plan.target.projectName} · {plan.target.environmentName}
                </h3>
                <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line">
                  {plan.services.map((s) => (
                    <li key={s.id} className="flex flex-col gap-0.5 px-4 py-2.5">
                      <span className="flex items-center gap-2 text-[13px] text-fg">
                        <span className="truncate font-medium">{s.name}</span>
                        {s.newName !== s.name && (
                          <>
                            <ArrowRight className="size-3.5 flex-none text-faint" />
                            <span className="truncate font-medium text-accent">{s.newName}</span>
                          </>
                        )}
                      </span>
                      {s.notes.map((n) => (
                        <span key={n} className="text-xs text-muted">
                          {n}
                        </span>
                      ))}
                    </li>
                  ))}
                </ul>
                {renamed.length === 0 && plan.rewritten.length === 0 && <p className="text-xs text-muted">Names stay the same.</p>}
                {plan.rewritten.length > 0 && <p className="text-xs text-muted">References between the moved services are updated to the new names.</p>}
              </section>

              {plan.suggestions.length > 0 && (
                <section className="flex flex-col gap-2">
                  <h3 className="text-[12px] font-medium tracking-wide text-faint uppercase">Move along</h3>
                  <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line">
                    {plan.suggestions.map((s) => (
                      <li key={s.id}>
                        <label className="flex cursor-pointer items-center gap-3 px-4 py-2.5 hover:bg-hover">
                          <Checkbox checked={extra.includes(s.id)} onCheckedChange={(c) => setExtra((prev) => (c ? [...prev, s.id] : prev.filter((x) => x !== s.id)))} />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-[13px] font-medium text-fg">Also move {s.name}</span>
                            <span className="block truncate font-mono text-[11.5px] text-muted">{s.reason}</span>
                          </span>
                        </label>
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {broken.length > 0 && (
                <section className="flex flex-col gap-2">
                  <h3 className="flex items-center gap-1.5 text-[12px] font-medium tracking-wide text-warn uppercase">
                    <Link2Off className="size-3.5" /> {broken.length} reference{broken.length === 1 ? "" : "s"} will stop working
                  </h3>
                  <ul className="divide-y divide-line overflow-hidden rounded-xl border border-warn/25">
                    {broken.map((b) => (
                      <li key={`${b.serviceId}:${b.key}:${b.ref}`} className="flex flex-col gap-0.5 px-4 py-2.5">
                        <span className="truncate font-mono text-[12px] text-fg-2">
                          {b.serviceName} · {b.key}={`\${{${b.ref}}}`}
                        </span>
                        <span className="text-xs text-muted">{b.reason}</span>
                      </li>
                    ))}
                  </ul>
                  <p className="text-xs text-muted">Deploys that need them stop with a missing reference until you fix the variable or move the service it points at.</p>
                </section>
              )}
            </>
          )}
        </DialogBody>
        <DialogFooter>
          <DialogClose render={<Button variant="ghost" size="sm" />}>Cancel</DialogClose>
          <Button variant="primary" size="sm" onClick={move} loading={pending} disabled={!plan || plan.blockers.length > 0 || isLoading}>
            <MoveRight /> Move{count > 1 ? ` ${count} services` : ""}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
