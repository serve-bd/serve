"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Check, ChevronsUpDown, Plus, Settings, Users } from "lucide-react";
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogClose } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/misc";
import { toast } from "@/components/ui/toast";
import { createOrg, switchOrganization } from "@/server/actions/org";
import { cn } from "@/lib/utils";

export type OrgItem = { id: string; name: string; logo: string | null; role: string; isRoot: boolean };

export function OrgAvatar({ name, className }: { name: string; className?: string }) {
  const hue = [...name].reduce((a, c) => a + c.charCodeAt(0), 0) % 360;
  return (
    <span
      className={cn("flex size-6 shrink-0 items-center justify-center rounded-md text-[11px] font-bold text-white", className)}
      style={{ background: `linear-gradient(135deg, oklch(0.62 0.14 ${hue}), oklch(0.5 0.14 ${(hue + 40) % 360}))` }}
    >
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}

export function OrgSwitcher({ current, orgs, canCreate }: { current: OrgItem; orgs: OrgItem[]; canCreate: boolean }) {
  const router = useRouter();
  const [createOpen, setCreateOpen] = React.useState(false);
  const [pending, setPending] = React.useState(false);

  async function switchTo(id: string) {
    if (id === current.id) return;
    const res = await switchOrganization(id);
    if (!res.ok) return toast.error(res.error);
    router.push("/");
    router.refresh();
  }

  return (
    <>
      <Menu>
        <MenuTrigger className="group flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-hover data-[popup-open]:bg-hover">
          <OrgAvatar name={current.name} />
          <span className="flex min-w-0 flex-1 flex-col leading-tight">
            <span className="truncate text-[13px] font-semibold text-fg">{current.name}</span>
            <span className="truncate text-[11px] text-muted capitalize">{current.isRoot ? "Root · " : ""}{current.role}</span>
          </span>
          <ChevronsUpDown className="size-3.5 text-faint group-hover:text-muted" />
        </MenuTrigger>
        <MenuContent align="start" className="w-64">
          <MenuLabel>Organizations</MenuLabel>
          {orgs.map((o) => (
            <MenuItem key={o.id} onClick={() => switchTo(o.id)}>
              <OrgAvatar name={o.name} className="size-5 text-[10px]" />
              <span className="flex-1 truncate">{o.name}</span>
              {o.isRoot && <Badge tone="accent">Root</Badge>}
              {o.id === current.id && <Check className="!text-accent" />}
            </MenuItem>
          ))}
          <MenuSeparator />
          <MenuItem onClick={() => router.push("/organization/members")}>
            <Users /> Members
          </MenuItem>
          <MenuItem onClick={() => router.push("/organization")}>
            <Settings /> Organization settings
          </MenuItem>
          {canCreate && (
            <MenuItem onClick={() => setCreateOpen(true)}>
              <Plus /> Create organization
            </MenuItem>
          )}
        </MenuContent>
      </Menu>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent size="sm">
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const name = String(new FormData(e.currentTarget).get("name"));
              setPending(true);
              const res = await createOrg(name);
              setPending(false);
              if (!res.ok) return toast.error(res.error);
              setCreateOpen(false);
              toast.success(`Created ${name}`);
              router.push("/");
              router.refresh();
            }}
          >
            <DialogHeader
              title="Create organization"
              description="Organizations keep projects, integrations and members separate. You will be the owner."
            />
            <DialogBody>
              <Field label="Name">
                <Input name="name" required minLength={2} autoFocus placeholder="Acme Inc." />
              </Field>
            </DialogBody>
            <DialogFooter>
              <DialogClose render={<Button variant="ghost" size="sm" />}>Cancel</DialogClose>
              <Button type="submit" variant="primary" size="sm" loading={pending}>
                Create organization
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
