"use client";

import { showError } from "@/hooks/use-action";
import * as React from "react";
import { createPortal } from "react-dom";
import { useRouter } from "@/hooks/use-router";
import { Check, ChevronsUpDown, Loader2, Plus, Settings, Users } from "lucide-react";
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogClose } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/misc";
import { createOrg, switchOrganization } from "@/server/actions/org";

export type OrgItem = { id: string; name: string; logo: string | null; role: string; isRoot: boolean };

export function OrgSwitcher({ current, orgs, canCreate }: { current: OrgItem; orgs: OrgItem[]; canCreate: boolean }) {
  const router = useRouter();
  const [createOpen, setCreateOpen] = React.useState(false);
  const [pending, setPending] = React.useState(false);
  // The org being opened. The overlay stays until the shell shows it, so nothing is clicked in the old one meanwhile.
  const [switching, setSwitching] = React.useState<OrgItem | null>(null);
  const [navigating, startNavigation] = React.useTransition();
  const busy = !!switching && (navigating || switching.id !== current.id);
  // Set once the navigation to the other organization has begun.
  const navStarted = React.useRef(false);

  // The switch ends when the shell shows the new organization: the next switch can start. If the
  // navigation finished but the shell still shows the old one, a full load shows the right one.
  React.useEffect(() => {
    if (!switching || navigating || !navStarted.current) return;
    navStarted.current = false;
    if (switching.id === current.id) setSwitching(null);
    else window.location.assign("/");
  }, [switching, navigating, current.id]);

  async function switchTo(org: OrgItem) {
    if (org.id === current.id || switching) return;
    setSwitching(org);
    const res = await switchOrganization(org.id);
    if (!res.ok) {
      setSwitching(null);
      return showError(res.error);
    }
    navStarted.current = true;
    startNavigation(() => {
      router.push("/");
      router.refresh();
    });
  }

  return (
    <>
      <Menu>
        <MenuTrigger className="group flex w-full items-center gap-2.5 rounded-lg bg-fg/[0.04] px-3 py-2 text-left ring-1 ring-line transition-colors hover:bg-fg/[0.07] data-[popup-open]:bg-fg/[0.07]">
          <span className="flex min-w-0 flex-1 flex-col leading-tight">
            <span className="truncate text-[13px] font-semibold text-fg">{current.name}</span>
            <span className="truncate text-[11px] text-muted capitalize">
              {current.isRoot ? "Root · " : ""}
              {current.role}
            </span>
          </span>
          <ChevronsUpDown className="size-3.5 text-faint group-hover:text-muted" />
        </MenuTrigger>
        <MenuContent align="start" className="w-64">
          <MenuLabel>Organizations</MenuLabel>
          {orgs.map((o) => (
            <MenuItem key={o.id} onClick={() => switchTo(o)}>
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

      {busy && switching && <SwitchingOverlay name={switching.name} />}

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent size="sm">
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const name = String(new FormData(e.currentTarget).get("name"));
              setPending(true);
              const res = await createOrg(name).finally(() => setPending(false));
              if (!res.ok) return showError(res.error);
              setCreateOpen(false);
              router.push("/");
              router.refresh();
            }}
          >
            <DialogHeader title="Create organization" description="Organizations keep projects, integrations and members separate. You will be the owner." />
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

/** Covers the app while another organization opens. It fades in late, so a quick switch does not flash. */
function SwitchingOverlay({ name }: { name: string }) {
  return createPortal(
    <div
      role="status"
      aria-live="polite"
      aria-busy
      className="fixed inset-0 z-[100] flex animate-[fade-in_200ms_ease-out_120ms_both] items-center justify-center bg-bg/70 backdrop-blur-[3px]"
    >
      <div className="flex items-center gap-3 rounded-xl border border-line bg-surface px-4 py-3 shadow-lg">
        <Loader2 className="size-4 animate-spin text-accent" />
        <span className="text-[13px] text-fg-2">
          Switching to <span className="font-semibold text-fg">{name}</span>
        </span>
      </div>
    </div>,
    document.body,
  );
}
