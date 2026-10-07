"use client";

import * as React from "react";
import { Database, Folder, HardDrive, MoreHorizontal, Plus, Trash2 } from "lucide-react";
import { useRouter } from "@/hooks/use-router";
import { useConfirm } from "@/components/ui/confirm";
import { useAction } from "@/hooks/use-action";
import { deleteKeptData } from "@/server/actions/kept-data";
import type { KeptData } from "@/server/services/kept-data";
import { formatBytes } from "@/lib/utils";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu";
import { Card, TimeAgo } from "@/components/ui/misc";
import { toast } from "@/components/ui/toast";
import { useDeleteGuard } from "@/app/(app)/account/confirm-identity";

export type KeptActions = { onStart: ((k: KeptData) => void) | null; onDelete: ((k: KeptData) => void) | null };

/** A kept volume's own part: serve-<slug>-uploads is "uploads", a stack's <project>_db is "db". */
function keptShortName(volume: string) {
  if (volume.startsWith("/")) return volume.split("/").filter(Boolean).at(-1) ?? volume;
  const compose = volume.indexOf("_");
  if (compose > 0) return volume.slice(compose + 1);
  return volume.replace(/^serve-.+?-[a-z0-9]{6}-/, "");
}

/** What the card shows: the deleted service's name and the volume's own part, like main-db-data. */
export const keptLabel = (k: KeptData) => `${k.serviceName}-${k.kind === "database" ? "data" : keptShortName(k.volume)}`;

export function KeptIcon({ k, className }: { k: KeptData; className?: string }) {
  if (k.kind === "database") return <Database className={className} />;
  return k.volume.startsWith("/") ? <Folder className={className} /> : <HardDrive className={className} />;
}

/**
 * Start a database on kept data, or delete it (typing its name and the delete proof first).
 * `dialog`: the identity check a delete may need; render it with the actions.
 */
export function useKeptActions(projectId: string, environmentName: string, canManage: boolean, onChange: () => void): { actions: KeptActions; dialog: React.ReactNode } {
  const router = useRouter();
  const confirm = useConfirm();
  const deleteGuard = useDeleteGuard();
  const removeKept = useAction((k: KeptData, password: string | null) => deleteGuard.guard(() => deleteKeptData(k.kind, k.id, password)), {
    onSuccess: (d) => {
      // A folder or a volume made outside Serve stays: say where, as nothing on the page shows it.
      if (d?.note) toast.info("Kept data forgotten", d.note);
      onChange();
    },
  });
  const actions = React.useMemo(
    (): KeptActions => ({
      onStart: canManage ? (k: KeptData) => router.push(`/projects/${projectId}/new?env=${encodeURIComponent(environmentName)}&type=database&kept=${k.id}`) : null,
      onDelete: canManage
        ? async (k: KeptData) => {
            let password: string | null = null;
            const folder = k.volume.startsWith("/");
            if (
              await confirm({
                password: (p) => {
                  password = p;
                },
                title: `Delete the data of ${k.serviceName}?`,
                description: folder
                  ? `Serve forgets this data. The folder ${k.volume} stays on ${k.serverName || "the server"}.`
                  : k.owned
                    ? `The volume ${k.volume} and all data in it are permanently deleted from ${k.serverName || "the server"}. This cannot be undone.`
                    : `Serve forgets this data. The volume ${k.volume} was made outside Serve and stays on ${k.serverName || "the server"}.`,
                confirmLabel: "Delete data",
                danger: true,
                typeToConfirm: k.volume,
              })
            )
              void removeKept.run(k, password);
          }
        : null,
    }),
    [canManage, router, projectId, environmentName, confirm, removeKept.run],
  );
  return { actions, dialog: deleteGuard.dialog };
}

export function KeptMenu({ k, actions }: { k: KeptData; actions: KeptActions }) {
  if (!actions.onStart && !actions.onDelete) return null;
  return (
    <Menu>
      <MenuTrigger className="nodrag nopan flex-none rounded-md p-1 text-faint transition-colors hover:bg-hover hover:text-fg" aria-label={`Actions for ${k.volume}`}>
        <MoreHorizontal className="size-4" />
      </MenuTrigger>
      <MenuContent>
        {actions.onStart && k.kind === "database" && (
          <MenuItem onClick={() => actions.onStart?.(k)}>
            <Plus /> Start a database on it
          </MenuItem>
        )}
        {actions.onDelete && (
          <MenuItem danger onClick={() => actions.onDelete?.(k)}>
            <Trash2 /> Delete data
          </MenuItem>
        )}
      </MenuContent>
    </Menu>
  );
}

/** The grid and list views: kept data under the services, one row each. */
export function KeptList({ kept, actions }: { kept: KeptData[]; actions: KeptActions }) {
  if (!kept.length) return null;
  return (
    <section className="flex flex-col gap-3">
      <h2 className="flex items-center gap-2 text-[13px] font-semibold text-fg-2">
        Data kept from deleted services
        <span className="rounded-md bg-surface-2 px-1.5 py-px text-[11px] font-medium text-muted tabular-nums">{kept.length}</span>
      </h2>
      <Card className="divide-y divide-line overflow-hidden border-dashed">
        {kept.map((k) => (
          <div key={`${k.kind}:${k.id}`} className="flex items-center gap-3 px-4 py-3" title={`${k.volume} on ${k.serverName || "its server"}`}>
            <span className="flex size-8 flex-none items-center justify-center rounded-lg bg-surface-2 text-muted">
              <KeptIcon k={k} className="size-4" />
            </span>
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-[13px] font-medium text-fg">{keptLabel(k)}</span>
              <span className="truncate text-xs text-muted">
                From deleted {k.serviceName}
                {k.engine ? ` · ${k.engine} ${k.version ?? ""}` : ""}
              </span>
            </div>
            <span className="hidden flex-none text-xs text-muted tabular-nums sm:inline">{k.bytes !== null ? formatBytes(k.bytes) : ""}</span>
            <span className="hidden flex-none text-xs text-faint sm:inline">
              Kept <TimeAgo date={k.createdAt} />
            </span>
            <KeptMenu k={k} actions={actions} />
          </div>
        ))}
      </Card>
    </section>
  );
}
