"use client";

import * as React from "react";
import { Download, FileCode2, RotateCcw } from "lucide-react";
import { Badge, Card, CardBody, CardHeader, TimeAgo } from "@/components/ui/misc";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { useConfirm } from "@/components/ui/confirm";
import { useAction } from "@/hooks/use-action";
import { exportServeConfig, resetToServeConfig, restoreServeConfigValue } from "@/server/actions/serve-config";
import type { ServiceConfigFile } from "@/server/db/schema";
import type { BuildConfig, RuntimeConfig } from "@/server/services/types";

type Ctx = { file: ServiceConfigFile | null; build: BuildConfig | null; runtime: RuntimeConfig };
const ConfigFileContext = React.createContext<Ctx | null>(null);

export function ConfigFileProvider({ children, ...value }: Ctx & { children: React.ReactNode }) {
  return <ConfigFileContext.Provider value={value}>{children}</ConfigFileContext.Provider>;
}

/** The saved value of a setting, by its serve.json field name ("runtime.replicas"). */
function savedValue(ctx: Ctx, field: string) {
  const [group, key] = field.split(".") as ["build" | "runtime", string];
  if (field === "runtime.volumes") return ctx.runtime.volumes.map((v) => v.mountPath);
  return (ctx[group] as Record<string, unknown> | null)?.[key];
}

const same = (field: string, saved: unknown, file: unknown) => {
  // The file's mounts are still all there (the dashboard may have added more of its own).
  if (field === "runtime.volumes") return (file as string[]).every((p) => (saved as string[]).includes(p));
  return JSON.stringify(saved ?? null) === JSON.stringify(file ?? null);
};

/** Build and runtime settings this page has the saved values of (HTTP options and the uptime check live elsewhere). */
const comparable = (field: string) => field.startsWith("build.") || field.startsWith("runtime.");

/** Settings serve.json set that were changed in the dashboard since. */
function overrides(ctx: Ctx) {
  return (ctx.file?.settings ?? []).filter((s) => comparable(s.field) && !same(s.field, savedValue(ctx, s.field), s.value));
}

const shown = (v: unknown) => (v === null || v === undefined || v === "" ? "nothing" : typeof v === "string" ? v : JSON.stringify(v));

/**
 * A mark next to a setting serve.json controls: "serve.json" while it has the file's value,
 * "Changed here" once the dashboard changed it. A change made here stays on every deploy.
 */
export function FromFile({ field }: { field: string | string[] }) {
  const ctx = React.useContext(ConfigFileContext);
  if (!ctx?.file) return null;
  const fields = Array.isArray(field) ? field : [field];
  const set = ctx.file.settings.filter((s) => fields.includes(s.field));
  if (!set.length) return null;
  const changed = set.filter((s) => comparable(s.field) && !same(s.field, savedValue(ctx, s.field), s.value));
  const path = ctx.file.path;
  if (changed.length)
    return (
      <Tooltip content={`${path} sets ${changed.map((s) => shown(s.value)).join(", ")}. Deploys keep this change; Settings → General puts the file's value back.`}>
        <Badge tone="warn" className="ml-2 align-middle">
          Changed here
        </Badge>
      </Tooltip>
    );
  return (
    <Tooltip content={`Set in ${path}. A change made here stays: deploys no longer change it from the file.`}>
      <Badge tone="info" className="ml-2 align-middle font-mono">
        {path.split("/").pop()}
      </Badge>
    </Tooltip>
  );
}

/** On the General page of apps: what serve.json controls, how to start one, and putting its values back. */
export function ServeConfigCard({ serviceId, canManage }: { serviceId: string; canManage: boolean }) {
  const ctx = React.useContext(ConfigFileContext);
  const confirm = useConfirm();
  const [open, setOpen] = React.useState(false);
  const reset = useAction(() => resetToServeConfig(serviceId));
  const restore = useAction((field: string) => restoreServeConfigValue(serviceId, field));
  const download = useAction(() => exportServeConfig(serviceId), {
    onSuccess: (r) => {
      const url = URL.createObjectURL(new Blob([r.text], { type: "application/json" }));
      const a = Object.assign(document.createElement("a"), { href: url, download: "serve.json" });
      a.click();
      URL.revokeObjectURL(url);
    },
  });
  if (!ctx) return null;
  const file = ctx.file;
  const changed = overrides(ctx);

  const downloadButton = canManage && (
    <Button size="sm" variant="secondary" onClick={() => download.run()} loading={download.pending}>
      <Download /> Download serve.json
    </Button>
  );

  if (!file)
    return (
      <Card>
        <CardHeader
          title="serve.json"
          description="Keep this app's build, deploy, health check, resources, storage and scheduled tasks in a serve.json next to your code. Each deploy applies it."
          actions={downloadButton}
        />
      </Card>
    );

  return (
    <Card>
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            <FileCode2 className="size-4 text-muted" /> <span className="font-mono">{file.path}</span>
          </span>
        }
        description={
          <>
            Applied <TimeAgo date={file.appliedAt} />
            {file.commitSha ? ` from ${file.commitSha.slice(0, 7)}` : ""}. Each deploy applies it, except what you changed here: settings, variables and tasks changed, disabled or
            deleted here stay that way.
          </>
        }
        actions={downloadButton}
      />
      <CardBody className="flex flex-col gap-3 text-[13px]">
        <div className="flex flex-wrap gap-2">
          <Badge>
            {file.settings.length} {file.settings.length === 1 ? "setting" : "settings"}
          </Badge>
          {file.tasks.length > 0 && (
            <Badge>
              {file.tasks.length} scheduled {file.tasks.length === 1 ? "task" : "tasks"}
            </Badge>
          )}
          {file.required.length > 0 && <Badge>Requires {file.required.join(", ")}</Badge>}
          {changed.length > 0 && <Badge tone="warn">{changed.length} changed here</Badge>}
        </div>
        {changed.length > 0 && canManage && (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line bg-surface-2 px-3 py-2.5">
            <div className="flex flex-col gap-1.5">
              <span className="text-fg-2">Changed here, kept on deploy:</span>
              <div className="flex flex-wrap gap-1.5">
                {changed.map((c) => (
                  <Tooltip key={c.field} content={`Use the value in ${file.path}: ${shown(c.value)}`}>
                    <button
                      type="button"
                      disabled={restore.pending}
                      onClick={() => restore.run(c.field)}
                      className="inline-flex items-center gap-1 rounded-md border border-line px-2 py-0.5 font-mono text-[12px] text-fg-2 transition-colors hover:bg-hover"
                    >
                      {c.field.split(".")[1]} <RotateCcw className="size-3" />
                    </button>
                  </Tooltip>
                ))}
              </div>
            </div>
            <Button
              size="sm"
              variant="secondary"
              loading={reset.pending}
              onClick={async () => {
                if (
                  await confirm({
                    title: `Put the ${file.path} values back?`,
                    description: "Every change made here is replaced with the file's values: settings, variables and tasks, also ones deleted here. They apply on the next deploy.",
                    confirmLabel: "Put back",
                  })
                )
                  reset.run();
              }}
            >
              <RotateCcw /> Put {file.path.split("/").pop()} values back
            </Button>
          </div>
        )}
        <button type="button" onClick={() => setOpen((o) => !o)} className="self-start text-[13px] text-accent hover:underline">
          {open ? "Hide the file" : "Show the file"}
        </button>
        {open && <pre className="max-h-96 overflow-auto rounded-lg border border-line bg-surface-2 p-3 font-mono text-[12px] leading-relaxed text-fg-2">{file.text}</pre>}
      </CardBody>
    </Card>
  );
}
