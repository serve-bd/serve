"use client";

import * as React from "react";
import useSWR from "swr";
import { Copy, Info, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogBody, DialogClose, DialogContent, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { useAction } from "@/hooks/use-action";
import { useRouter } from "@/hooks/use-router";
import { cloneServiceAction, cloneTargets } from "@/server/actions/services";

/** Copy one service into any environment and onto any server, then open the copy. */
export function CloneServiceDialog({
  service,
  open,
  onOpenChange,
}: {
  service: { id: string; name: string; type: string; environmentId: string; projectId: string; serverId: string | null };
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const { data } = useSWR(open ? "clone-targets" : null, async () => {
    const res = await cloneTargets();
    if (!res.ok) throw new Error(res.error);
    return res.data;
  });
  const [name, setName] = React.useState("");
  const [projectId, setProjectId] = React.useState(service.projectId);
  const [environmentId, setEnvironmentId] = React.useState(service.environmentId);
  const [serverId, setServerId] = React.useState(service.serverId ?? "");
  const [copyData, setCopyData] = React.useState(false);
  const [notes, setNotes] = React.useState<{ id: string; projectId: string; list: string[] } | null>(null);

  // Only when it opens: the service prop is a new object on every render.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on open only
  React.useEffect(() => {
    if (!open) return;
    setName(`${service.name}-copy`);
    setProjectId(service.projectId);
    setEnvironmentId(service.environmentId);
    setServerId(service.serverId ?? "");
    setCopyData(false);
    setNotes(null);
  }, [open]);

  const project = data?.projects.find((p) => p.id === projectId);
  const clone = useAction(() => cloneServiceAction(service.id, { name: name.trim(), environmentId, serverId, copyData }), {
    refresh: false,
    onSuccess: (r) => {
      if (r.notes.length) setNotes({ id: r.id, projectId, list: r.notes });
      else {
        onOpenChange(false);
        router.push(`/projects/${projectId}/services/${r.id}`);
      }
    },
  });
  const ready = !!data && !!name.trim() && !!environmentId && !!serverId;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="md">
        {notes ? (
          <>
            <DialogHeader title="Copy made" description="It is not deployed yet. A few things stayed with the original:" />
            <DialogBody>
              <ul className="flex flex-col gap-1.5 text-[13px] leading-relaxed text-fg-2">
                {notes.list.map((n) => (
                  <li key={n} className="flex gap-2">
                    <Info className="mt-0.5 size-3.5 flex-none text-muted" /> {n}
                  </li>
                ))}
              </ul>
            </DialogBody>
            <DialogFooter>
              <Button
                size="sm"
                variant="primary"
                onClick={() => {
                  onOpenChange(false);
                  router.push(`/projects/${notes.projectId}/services/${notes.id}`);
                }}
              >
                Open the copy
              </Button>
            </DialogFooter>
          </>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (ready) void clone.run();
            }}
          >
            <DialogHeader
              title={`Clone ${service.name}`}
              description="A new service with the same settings, variables and scheduled tasks. Nothing is deployed until you deploy it."
            />
            <DialogBody>
              {!data ? (
                <p className="flex items-center gap-2 text-[13px] text-muted">
                  <Loader2 className="size-4 animate-spin" /> Loading projects and servers…
                </p>
              ) : (
                <>
                  <Field label="Name">
                    <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
                  </Field>
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <Field label="Project">
                      <Select
                        value={projectId}
                        onValueChange={(id) => {
                          setProjectId(id);
                          setEnvironmentId(data.projects.find((p) => p.id === id)?.environments[0]?.id ?? "");
                        }}
                        options={data.projects.map((p) => ({ value: p.id, label: p.name }))}
                      />
                    </Field>
                    <Field label="Environment">
                      <Select value={environmentId} onValueChange={setEnvironmentId} options={(project?.environments ?? []).map((e) => ({ value: e.id, label: e.name }))} />
                    </Field>
                  </div>
                  <Field label="Server">
                    <Select value={serverId} onValueChange={setServerId} options={data.servers.map((s) => ({ value: s.id, label: s.name }))} />
                  </Field>
                  {service.type === "database" && (
                    <label className="flex items-start gap-2.5 text-[13px] text-fg-2">
                      <Checkbox checked={copyData} onCheckedChange={(c) => setCopyData(!!c)} className="mt-0.5" />
                      <span>
                        Copy the data too
                        <span className="block text-xs text-muted">The copy starts, then gets a dump of this database. Without it, the copy starts empty.</span>
                      </span>
                    </label>
                  )}
                </>
              )}
            </DialogBody>
            <DialogFooter>
              <DialogClose render={<Button variant="ghost" size="sm" />}>Cancel</DialogClose>
              <Button type="submit" variant="primary" size="sm" loading={clone.pending} disabled={!ready}>
                <Copy /> Clone
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
