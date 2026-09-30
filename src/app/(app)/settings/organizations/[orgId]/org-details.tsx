"use client";

import * as React from "react";
import Link from "next/link";
import { Building2, ChevronLeft, Info, MoreHorizontal, Pencil, Trash2, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Combobox } from "@/components/ui/combobox";
import { useConfirm } from "@/components/ui/confirm";
import { Dialog, DialogBody, DialogClose, DialogContent, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu";
import { Avatar, Badge, Card, CardBody, CardHeader, TimeAgo } from "@/components/ui/misc";
import { Select } from "@/components/ui/select";
import { UsageBars } from "@/components/usage-bars";
import { useAction } from "@/hooks/use-action";
import { hasAnyLimit, limitCatalog } from "@/lib/limits";
import { addUserToOrganization, removeOrganizationMember, setOrganizationMemberRole } from "@/server/actions/instance-members";
import { LimitsDialog, LimitSummary, type Org, type Server } from "../org-limits";

type Role = { id: string; name: string; description: string | null };
type Member = { id: string; role: string; roleId: string; createdAt: string; userId: string; name: string; email: string; image: string | null };
type User = { id: string; name: string; email: string };
type Invite = { id: string; email: string; role: string; expiresAt: string };

export function OrgDetails({
  org,
  createdAt,
  canEdit,
  me,
  roles,
  members,
  users,
  invitations,
  servers,
}: {
  org: Org;
  createdAt: string;
  canEdit: boolean;
  me: string;
  roles: Role[];
  members: Member[];
  users: User[];
  invitations: Invite[];
  servers: Server[];
}) {
  const confirm = useConfirm();
  const [adding, setAdding] = React.useState(false);
  const [limits, setLimits] = React.useState(false);
  const changeRole = useAction((memberId: string, roleId: string) => setOrganizationMemberRole(org.id, memberId, roleId), { success: "Role updated" });
  const remove = useAction((memberId: string) => removeOrganizationMember(org.id, memberId), { success: "Member removed" });
  const roleName = (id: string) => roles.find((r) => r.id === id)?.name ?? "Viewer";

  return (
    <div className="flex flex-col gap-6">
      <Link href="/settings/organizations" className="-mb-2 flex w-fit items-center gap-1 text-[13px] text-muted hover:text-fg">
        <ChevronLeft className="size-4" /> Organizations
      </Link>

      <Card>
        <div className="flex flex-wrap items-center gap-3 px-5 py-4">
          <span className="flex size-10 flex-none items-center justify-center rounded-xl bg-fg/[0.05] text-muted">
            <Building2 className="size-5" />
          </span>
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="flex flex-wrap items-center gap-2 text-[17px] font-semibold text-fg">
              <span className="truncate">{org.name}</span>
              {org.root && <Badge tone="info">Root</Badge>}
            </span>
            <span className="text-xs text-muted">
              Created <TimeAgo date={createdAt} /> · {members.length} member{members.length === 1 ? "" : "s"} · {org.usage.projects ?? 0} project
              {org.usage.projects === 1 ? "" : "s"} · {org.usage.services ?? 0} service{org.usage.services === 1 ? "" : "s"}
            </span>
          </div>
        </div>
      </Card>

      <Card className="overflow-hidden">
        <CardHeader
          title="Members"
          description="Add people who already have an account. They get access at once, without an invite."
          actions={
            canEdit && (
              <Button
                size="sm"
                variant="primary"
                onClick={() => setAdding(true)}
                disabled={!users.length}
                title={users.length ? undefined : "Everyone with an account is already a member."}
              >
                <UserPlus /> Add member
              </Button>
            )
          }
        />
        {!canEdit && (
          <p className="flex items-start gap-2 border-b border-line bg-surface-2 px-5 py-3 text-[13px] text-fg-2">
            <Info className="mt-0.5 size-4 flex-none text-muted" />
            <span>
              Only owners of the Root organization change its members here. Admins use{" "}
              <Link href="/organization/members" className="text-accent hover:underline">
                Organization → Members
              </Link>
              .
            </span>
          </p>
        )}
        <div className="divide-y divide-line">
          {members.length === 0 && <p className="px-5 py-6 text-center text-[13px] text-muted">No members. Add someone so the organization can be used.</p>}
          {members.map((m) => (
            <div key={m.id} className="flex flex-wrap items-center gap-3 px-5 py-3 sm:flex-nowrap">
              <Avatar name={m.name} src={m.image} className="size-8" />
              {/* On phones the role moves under the name, so the name keeps its room. */}
              <div className="flex min-w-[12rem] flex-1 flex-col">
                <span className="truncate text-[14px] font-medium text-fg">
                  {m.name} {m.userId === me && <span className="text-xs font-normal text-muted">(you)</span>}
                </span>
                <span className="truncate text-xs text-muted">
                  {m.email} · joined <TimeAgo date={m.createdAt} />
                </span>
              </div>
              {canEdit ? (
                <Select
                  size="sm"
                  value={m.roleId}
                  onValueChange={(r) => changeRole.run(m.id, r)}
                  options={roles.map((r) => ({ value: r.id, label: r.name, description: r.description ?? undefined }))}
                  className="ml-11 w-36 sm:ml-0"
                  aria-label={`Role of ${m.name}`}
                />
              ) : (
                <Badge tone={m.role === "owner" ? "accent" : "neutral"}>{roleName(m.roleId)}</Badge>
              )}
              {canEdit && (
                <Menu>
                  <MenuTrigger className="rounded-lg p-1.5 text-muted hover:bg-hover hover:text-fg" aria-label={`Actions for ${m.name}`}>
                    <MoreHorizontal className="size-4" />
                  </MenuTrigger>
                  <MenuContent>
                    <MenuItem
                      danger
                      onClick={async () => {
                        if (
                          await confirm({
                            title: `Remove ${m.name} from ${org.name}?`,
                            description: "They lose access to its projects. Their account stays.",
                            confirmLabel: "Remove",
                            danger: true,
                          })
                        )
                          remove.run(m.id);
                      }}
                    >
                      <Trash2 /> Remove from organization
                    </MenuItem>
                  </MenuContent>
                </Menu>
              )}
            </div>
          ))}
        </div>
      </Card>

      {invitations.length > 0 && (
        <Card className="overflow-hidden">
          <CardHeader title="Pending invitations" description="Invites sent from this organization's Members page that nobody has accepted yet." />
          <div className="divide-y divide-line">
            {invitations.map((i) => (
              <div key={i.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-5 py-3">
                <span className="min-w-0 flex-1 truncate text-[13px] text-fg">{i.email}</span>
                <Badge>{i.role}</Badge>
                <span className="text-xs text-muted">
                  expires <TimeAgo date={i.expiresAt} />
                </span>
              </div>
            ))}
          </div>
        </Card>
      )}

      <Card>
        <CardHeader
          title="Limits"
          description={
            org.custom
              ? "This organization has its own limits."
              : org.root
                ? "The Root organization is unlimited unless you set limits for it."
                : "This organization follows the default limits."
          }
          actions={
            <Button size="sm" onClick={() => setLimits(true)}>
              <Pencil /> Edit
            </Button>
          }
        />
        <CardBody className="flex flex-col gap-4 py-4">
          <LimitSummary limits={org.limits} empty="No limits." />
          {hasAnyLimit(org.limits) && <UsageBars usage={org.usage} limits={org.limits} only={limitCatalog.filter((l) => org.limits[l.key] != null).map((l) => l.key)} compact />}
        </CardBody>
      </Card>

      {adding && <AddMemberDialog org={org} roles={roles} users={users} onClose={() => setAdding(false)} />}
      {limits && <LimitsDialog org={org} initial={org.limits} servers={servers} onClose={() => setLimits(false)} />}
    </div>
  );
}

function AddMemberDialog({ org, roles, users, onClose }: { org: Org; roles: Role[]; users: User[]; onClose: () => void }) {
  const [userId, setUserId] = React.useState<string | null>(null);
  const [roleId, setRoleId] = React.useState("developer");
  const add = useAction(() => addUserToOrganization(org.id, userId!, roleId), { success: "Member added", onSuccess: onClose });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (userId) void add.run();
          }}
        >
          <DialogHeader
            title={`Add a member to ${org.name}`}
            description="They get access at once. To add someone without an account, invite them from the organization's Members page."
          />
          <DialogBody>
            <Field label="Person">
              <Combobox
                value={userId}
                onValueChange={setUserId}
                placeholder="Search by name or email…"
                options={users.map((u) => ({ value: u.id, label: `${u.name} (${u.email})` }))}
              />
            </Field>
            <Field label="Role">
              <Select value={roleId} onValueChange={setRoleId} options={roles.map((r) => ({ value: r.id, label: r.name, description: r.description ?? undefined }))} />
            </Field>
          </DialogBody>
          <DialogFooter>
            <DialogClose render={<Button variant="ghost" size="sm" />}>Cancel</DialogClose>
            <Button type="submit" variant="primary" size="sm" loading={add.pending} disabled={!userId}>
              Add member
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
