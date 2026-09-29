"use client";

import * as React from "react";
import { Check, Minus, Pencil, Plus, ShieldCheck, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardHeader } from "@/components/ui/misc";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogBody, DialogClose, DialogContent, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { useConfirm } from "@/components/ui/confirm";
import { useAction } from "@/hooks/use-action";
import { deleteRole, saveDeveloperPermissions, saveRole } from "@/server/actions/org";
import { PERMISSION_GROUPS, PERMISSION_INFO, type Permission } from "@/lib/permissions";
import { cn } from "@/lib/utils";

type Role = { id: string; name: string; description: string | null; builtin: string | null; permissions: Permission[]; members: number };

export function RolesView({ roles, canEdit }: { roles: Role[]; canEdit: boolean }) {
  const confirm = useConfirm();
  const [editing, setEditing] = React.useState<Role | "new" | null>(null);
  const remove = useAction(deleteRole, { success: "Role deleted" });
  const custom = roles.filter((r) => !r.builtin);

  return (
    <div className="flex flex-col gap-6">
      <Card className="overflow-hidden">
        <CardHeader
          title="Roles"
          description="Built-in roles cover most teams. Add a custom role for anything in between."
          actions={
            canEdit && (
              <Button size="sm" variant="primary" onClick={() => setEditing("new")}>
                <Plus /> New role
              </Button>
            )
          }
        />
        <div className="divide-y divide-line">
          {roles.map((r) => (
            <div key={r.id} className="flex flex-wrap items-center gap-3 px-5 py-3.5 sm:flex-nowrap">
              <span className="flex size-8 flex-none items-center justify-center rounded-lg bg-fg/[0.05] text-muted [&_svg]:size-4">
                <ShieldCheck />
              </span>
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="flex items-center gap-2 text-[14px] font-medium text-fg">
                  {r.name}
                  {r.builtin ? <Badge>Built-in</Badge> : <Badge tone="info">Custom</Badge>}
                </span>
                <span className="text-xs leading-relaxed text-muted">
                  {r.description ?? `${r.permissions.length} permissions`} · {r.members} member{r.members === 1 ? "" : "s"}
                </span>
              </div>
              <div className="flex flex-none items-center gap-1">
                {canEdit && (r.id === "developer" || !r.builtin) ? (
                  <Button size="sm" variant="ghost" onClick={() => setEditing(r)}>
                    <Pencil /> Edit
                  </Button>
                ) : (
                  <Button size="sm" variant="ghost" onClick={() => setEditing(r)}>
                    View
                  </Button>
                )}
                {canEdit && !r.builtin && (
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={`Delete ${r.name}`}
                    onClick={async () => {
                      if (
                        await confirm({
                          title: `Delete the ${r.name} role?`,
                          description: r.members
                            ? `${r.members} member${r.members === 1 ? " becomes a Viewer" : "s become Viewers"} until you give them another role.`
                            : "No member has this role.",
                          confirmLabel: "Delete role",
                          danger: true,
                        })
                      )
                        remove.run(r.id);
                    }}
                  >
                    <Trash2 />
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>
      </Card>

      <PermissionMatrix roles={roles} />

      {editing && (
        <RoleDialog
          role={editing === "new" ? null : editing}
          readOnly={!canEdit || (editing !== "new" && !!editing.builtin && editing.id !== "developer")}
          onClose={() => setEditing(null)}
        />
      )}
      {custom.length === 0 && canEdit && <p className="text-xs text-muted">Custom roles are shared by every project in this organization.</p>}
    </div>
  );
}

/** Every permission against every role, at a glance. */
function PermissionMatrix({ roles }: { roles: Role[] }) {
  return (
    <Card className="overflow-hidden">
      <CardHeader title="What each role can do" />
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-[13px]">
          <thead>
            <tr className="border-b border-line bg-surface-2 text-left text-[11px] font-medium tracking-wide text-faint uppercase">
              <th className="px-5 py-2.5 font-medium">Permission</th>
              {roles.map((r) => (
                <th key={r.id} className="px-3 py-2.5 text-center font-medium">
                  {r.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {PERMISSION_GROUPS.flatMap((g) => g.permissions).map((p) => (
              <tr key={p}>
                <td className="px-5 py-2.5 text-fg-2" title={PERMISSION_INFO[p].description}>
                  {PERMISSION_INFO[p].label}
                </td>
                {roles.map((r) => (
                  <td key={r.id} className="px-3 py-2.5 text-center">
                    {r.permissions.includes(p) ? <Check className="mx-auto size-4 text-ok" aria-label="Yes" /> : <Minus className="mx-auto size-4 text-faint" aria-label="No" />}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function RoleDialog({ role, readOnly, onClose }: { role: Role | null; readOnly: boolean; onClose: () => void }) {
  const [name, setName] = React.useState(role?.name ?? "");
  const [description, setDescription] = React.useState(role?.description ?? "");
  const [perms, setPerms] = React.useState<Set<Permission>>(new Set(role?.permissions ?? ["projects.view"]));
  const developer = role?.id === "developer";
  const save = useAction(() => (developer ? saveDeveloperPermissions([...perms]) : saveRole(role?.id ?? null, { name, description, permissions: [...perms] })), {
    success: "Role saved",
    onSuccess: onClose,
  });
  const toggle = (p: Permission, on: boolean) =>
    setPerms((s) => {
      const n = new Set(s);
      if (on) n.add(p);
      else n.delete(p);
      return n;
    });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="lg">
        <DialogHeader
          title={role ? (readOnly ? role.name : `Edit ${role.name}`) : "New role"}
          description={developer ? "Changes apply at once to every Developer in this organization." : "Members with this role get exactly these permissions."}
        />
        <DialogBody className="max-h-[65vh] overflow-y-auto [&>*]:shrink-0">
          {!role?.builtin && (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Name">
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Release manager" disabled={readOnly} maxLength={40} />
              </Field>
              <Field label="Description" optional>
                <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Deploys, cannot change settings" disabled={readOnly} maxLength={200} />
              </Field>
            </div>
          )}
          {PERMISSION_GROUPS.map((g) => (
            <section key={g.title} className="flex flex-col gap-2">
              <h3 className="text-[12px] font-medium tracking-wide text-faint uppercase">{g.title}</h3>
              <div className="divide-y divide-line overflow-hidden rounded-xl border border-line">
                {g.permissions.map((p) => {
                  const fixed = p === "projects.view";
                  return (
                    <label key={p} className={cn("flex items-start gap-3 px-3.5 py-2.5", !readOnly && !fixed && "cursor-pointer hover:bg-hover")}>
                      <Checkbox className="mt-0.5" checked={perms.has(p)} onCheckedChange={(c) => toggle(p, !!c)} disabled={readOnly || fixed} />
                      <span className="flex min-w-0 flex-col">
                        <span className="text-[13px] font-medium text-fg">{PERMISSION_INFO[p].label}</span>
                        <span className="text-xs leading-relaxed text-muted">{PERMISSION_INFO[p].description}</span>
                      </span>
                    </label>
                  );
                })}
              </div>
            </section>
          ))}
        </DialogBody>
        <DialogFooter>
          <DialogClose render={<Button variant="ghost" size="sm" />}>{readOnly ? "Close" : "Cancel"}</DialogClose>
          {!readOnly && (
            <Button variant="primary" size="sm" onClick={() => save.run()} loading={save.pending} disabled={!developer && !name.trim()}>
              Save role
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
