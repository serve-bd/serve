"use client";

import * as React from "react";
import Link from "next/link";
import { Building2, KeyRound, MoreHorizontal, Search, ShieldCheck, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogClose, DialogContent, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu";
import { Avatar, Badge, Card, CardHeader, CopyField, TimeAgo } from "@/components/ui/misc";
import { Select } from "@/components/ui/select";
import { useAction } from "@/hooks/use-action";
import { addUserToOrganization } from "@/server/actions/instance-members";
import { createPasswordResetLink } from "@/server/actions/email";

type Role = { id: string; name: string; description: string | null };
type Org = { id: string; name: string; root: boolean };
type Membership = { organizationId: string; name: string; root: boolean; role: string };
type User = {
  id: string;
  name: string;
  email: string;
  image: string | null;
  twoFactor: boolean;
  createdAt: string;
  lastActive: string | null;
  methods: string[];
  memberships: Membership[];
};

const METHOD_NAMES: Record<string, string> = { credential: "Password", github: "GitHub", google: "Google", oidc: "SSO" };

export function UsersView({ me, users, orgs, roles }: { me: string; users: User[]; orgs: Org[]; roles: Record<string, Role[]> }) {
  const [query, setQuery] = React.useState("");
  const [filter, setFilter] = React.useState("all");
  const [adding, setAdding] = React.useState<User | null>(null);
  const [resetLink, setResetLink] = React.useState<{ name: string; url: string } | null>(null);
  const [resetOpen, setResetOpen] = React.useState(false);
  const makeResetLink = useAction((userId: string) => createPasswordResetLink(userId), { refresh: false });
  const q = query.trim().toLowerCase();
  const shown = users.filter(
    (u) =>
      (!q || u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q)) &&
      (filter === "all" || (filter === "none" ? !u.memberships.length : u.memberships.some((m) => m.organizationId === filter))),
  );
  const orphans = users.filter((u) => !u.memberships.length).length;

  return (
    <div className="flex flex-col gap-6">
      <Card className="overflow-hidden">
        <CardHeader
          title={`${users.length} user${users.length === 1 ? "" : "s"}`}
          description={
            orphans
              ? `Everyone with an account on this instance. ${orphans} ${orphans === 1 ? "is" : "are"} in no organization and cannot use the dashboard yet.`
              : "Everyone with an account on this instance."
          }
        />
        <div className="flex flex-col gap-2 border-b border-line px-5 py-3 sm:flex-row">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-faint" />
            <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search by name or email" className="pl-9" aria-label="Search users" />
          </div>
          <Select
            value={filter}
            onValueChange={setFilter}
            className="sm:w-52"
            aria-label="Filter by organization"
            options={[{ value: "all", label: "Every user" }, { value: "none", label: "In no organization" }, ...orgs.map((o) => ({ value: o.id, label: `In ${o.name}` }))]}
          />
        </div>
        <div className="divide-y divide-line">
          {shown.length === 0 && <p className="px-5 py-8 text-center text-[13px] text-muted">No users match.</p>}
          {shown.map((u) => (
            <div key={u.id} className="flex items-start gap-3 px-5 py-3.5">
              <Avatar name={u.name} src={u.image} className="mt-0.5 size-8" />
              <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                <div className="flex min-w-0 flex-col">
                  <span className="truncate text-[14px] font-medium text-fg">
                    {u.name} {u.id === me && <span className="text-xs font-normal text-muted">(you)</span>}
                  </span>
                  <span className="truncate text-xs text-muted">{u.email}</span>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  {u.memberships.length === 0 ? (
                    <Badge tone="warn">No organization</Badge>
                  ) : (
                    u.memberships.map((m) => (
                      <Link key={m.organizationId} href={`/settings/organizations/${m.organizationId}`}>
                        <Badge tone={m.root ? "info" : "neutral"} className="hover:border-line-strong">
                          <Building2 className="size-3" /> {m.name} · {m.role}
                        </Badge>
                      </Link>
                    ))
                  )}
                </div>
                <span className="text-xs text-faint">
                  {u.methods.map((m) => METHOD_NAMES[m] ?? m).join(", ") || "No sign-in method"}
                  {u.twoFactor && (
                    <>
                      {" · "}
                      <ShieldCheck className="inline size-3 align-[-2px]" /> 2FA
                    </>
                  )}
                  {" · joined "}
                  <TimeAgo date={u.createdAt} />
                  {u.lastActive && (
                    <>
                      {" · active "}
                      <TimeAgo date={u.lastActive} />
                    </>
                  )}
                </span>
              </div>
              <Menu>
                <MenuTrigger className="rounded-lg p-1.5 text-muted hover:bg-hover hover:text-fg" aria-label={`Actions for ${u.name}`}>
                  <MoreHorizontal className="size-4" />
                </MenuTrigger>
                <MenuContent>
                  <MenuItem onClick={() => setAdding(u)} disabled={!orgs.some((o) => !u.memberships.some((m) => m.organizationId === o.id))}>
                    <UserPlus /> Add to organization…
                  </MenuItem>
                  {u.id !== me && (
                    <MenuItem
                      onClick={async () => {
                        const res = await makeResetLink.run(u.id);
                        if (res) {
                          setResetLink({ name: u.name, url: res.url });
                          setResetOpen(true);
                        }
                      }}
                    >
                      <KeyRound /> Create password reset link
                    </MenuItem>
                  )}
                </MenuContent>
              </Menu>
            </div>
          ))}
        </div>
      </Card>

      {adding && (
        <AddToOrgDialog user={adding} orgs={orgs.filter((o) => !adding.memberships.some((m) => m.organizationId === o.id))} roles={roles} onClose={() => setAdding(null)} />
      )}

      <Dialog open={resetOpen} onOpenChange={setResetOpen}>
        <DialogContent>
          <DialogHeader title="Password reset link" description={`Send this link to ${resetLink?.name}. It works once and expires in 1 hour.`} />
          <DialogBody>{resetLink && <CopyField value={resetLink.url} />}</DialogBody>
          <DialogFooter>
            <DialogClose render={<Button variant="primary" size="sm" />}>Done</DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function AddToOrgDialog({ user, orgs, roles, onClose }: { user: User; orgs: Org[]; roles: Record<string, Role[]>; onClose: () => void }) {
  const [orgId, setOrgId] = React.useState(orgs[0]?.id ?? "");
  const [roleId, setRoleId] = React.useState("developer");
  const add = useAction(() => addUserToOrganization(orgId, user.id, roleId), { onSuccess: onClose });
  const options = roles[orgId] ?? [];
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (orgId) void add.run();
          }}
        >
          <DialogHeader title={`Add ${user.name} to an organization`} description="They get access at once, without an invite." />
          <DialogBody>
            <Field label="Organization">
              <Select
                value={orgId}
                onValueChange={(v) => {
                  setOrgId(v);
                  // A custom role belongs to one organization.
                  if (!(roles[v] ?? []).some((r) => r.id === roleId)) setRoleId("developer");
                }}
                options={orgs.map((o) => ({ value: o.id, label: o.name }))}
              />
            </Field>
            <Field label="Role">
              <Select value={roleId} onValueChange={setRoleId} options={options.map((r) => ({ value: r.id, label: r.name, description: r.description ?? undefined }))} />
            </Field>
          </DialogBody>
          <DialogFooter>
            <DialogClose render={<Button variant="ghost" size="sm" />}>Cancel</DialogClose>
            <Button type="submit" variant="primary" size="sm" loading={add.pending} disabled={!orgId}>
              Add
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
