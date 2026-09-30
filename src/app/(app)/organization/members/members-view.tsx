"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "@/hooks/use-router";
import { FolderLock, KeyRound, Link2, LogOut, Mail, MoreHorizontal, Trash2, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Avatar, Badge, Card, CardHeader, CopyField, TimeAgo } from "@/components/ui/misc";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogBody, DialogClose, DialogContent, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { useConfirm } from "@/components/ui/confirm";
import { toast } from "@/components/ui/toast";
import { copyText } from "@/components/ui/clipboard";
import { useAction } from "@/hooks/use-action";
import { inviteMember, removeMember, revokeInvitation, setMemberProjects, setMemberRole } from "@/server/actions/org";
import { createPasswordResetLink } from "@/server/actions/email";
import { canGrant, type Permission } from "@/lib/permissions";

type Member = {
  id: string;
  role: string;
  roleId: string;
  projectIds: string[] | null;
  createdAt: string;
  userId: string;
  name: string;
  email: string;
  image: string | null;
};
type Invite = { id: string; email: string; roleId: string; expiresAt: string };
type Role = { id: string; name: string; description: string | null; builtin: string | null; permissions: Permission[] };

/** Roles the current member may give: the same rule the server applies. */
function grantable(roles: Role[], myRoleId: string, myPermissions: Permission[]) {
  return roles.filter((r) => canGrant({ roleId: myRoleId, permissions: myPermissions }, r));
}

export function MembersView({
  baseUrl,
  me,
  myRoleId,
  myPermissions,
  canManage,
  roles,
  projects,
  members,
  invitations,
  emailEnabled = false,
  canResetPasswords = false,
  addsDirectly = false,
}: {
  baseUrl: string;
  me: string;
  myRoleId: string;
  myPermissions: Permission[];
  canManage: boolean;
  roles: Role[];
  projects: { id: string; name: string }[];
  members: Member[];
  invitations: Invite[];
  emailEnabled?: boolean;
  /** Root admins can create reset links for instances without email. */
  canResetPasswords?: boolean;
  /** Root admins add people who already have an account without an invite. */
  addsDirectly?: boolean;
}) {
  const router = useRouter();
  const confirm = useConfirm();
  const isAdmin = myRoleId === "owner" || myRoleId === "admin";
  const options = grantable(roles, myRoleId, myPermissions);
  const roleName = (id: string) => roles.find((r) => r.id === id)?.name ?? "Viewer";
  // Developer when this member may give it, else the first role they may give.
  const defaultRole = options.some((o) => o.id === "developer") ? "developer" : (options[0]?.id ?? "");
  const [open, setOpen] = React.useState(false);
  const [email, setEmail] = React.useState("");
  const [roleId, setRoleId] = React.useState(defaultRole);
  const [link, setLink] = React.useState<string | null>(null);
  const [sent, setSent] = React.useState<{ ok: boolean; error: string | null } | null>(null);
  const [resetLink, setResetLink] = React.useState<{ name: string; url: string } | null>(null);
  const [access, setAccess] = React.useState<Member | null>(null);
  const inviteLink = (id: string) => `${baseUrl}/invite/${id}`;

  const invite = useAction(() => inviteMember({ email, roleId }), {
    onSuccess: (d) => {
      if (!d.id) {
        toast.success(`${email} was added`);
        setOpen(false);
        return;
      }
      setLink(inviteLink(d.id));
      setSent(d.emailed || d.emailError ? { ok: d.emailed, error: d.emailError } : null);
    },
  });
  const makeResetLink = useAction((userId: string) => createPasswordResetLink(userId), { refresh: false });
  const changeRole = useAction((id: string, r: string) => setMemberRole(id, r), { success: "Role updated" });
  const remove = useAction(removeMember, {
    onSuccess: (d) => {
      if (d.self) {
        toast.success("You left the organization");
        router.replace("/");
      } else toast.success("Member removed");
    },
  });
  const revoke = useAction(revokeInvitation, { success: "Invitation revoked" });
  // Only admins change admins and owners; only owners change owners.
  const canChange = (m: Member) => canManage && m.userId !== me && (m.role === "owner" ? myRoleId === "owner" : m.role === "admin" ? isAdmin : true);

  return (
    <div className="flex flex-col gap-6">
      <Card className="overflow-hidden">
        <CardHeader
          title={`${members.length} member${members.length === 1 ? "" : "s"}`}
          description={
            <>
              Each role decides what a member can do.{" "}
              <Link href="/organization/roles" className="text-accent hover:underline">
                Roles and permissions
              </Link>
            </>
          }
          actions={
            canManage && (
              <Button
                size="sm"
                variant="primary"
                onClick={() => {
                  setLink(null);
                  setEmail("");
                  setRoleId(defaultRole);
                  setOpen(true);
                }}
              >
                <UserPlus /> Invite
              </Button>
            )
          }
        />
        <div className="divide-y divide-line">
          {members.map((m) => {
            const limited = m.role === "member" && m.projectIds;
            return (
              <div key={m.id} className="flex flex-wrap items-center gap-3 px-5 py-3 sm:flex-nowrap">
                <Avatar name={m.name} src={m.image} className="size-8" />
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-[14px] font-medium text-fg">
                    {m.name} {m.userId === me && <span className="text-xs font-normal text-muted">(you)</span>}
                  </span>
                  <span className="truncate text-xs text-muted">
                    {m.email} · joined <TimeAgo date={m.createdAt} />
                  </span>
                </div>
                {limited && (
                  <Badge className="flex-none" title={m.projectIds!.map((id) => projects.find((p) => p.id === id)?.name ?? id).join(", ")}>
                    <FolderLock className="size-3" /> {m.projectIds!.length} project{m.projectIds!.length === 1 ? "" : "s"}
                  </Badge>
                )}
                {canChange(m) ? (
                  <Select
                    size="sm"
                    value={m.roleId}
                    onValueChange={(r) => changeRole.run(m.id, r)}
                    options={(options.some((o) => o.id === m.roleId) ? options : [...options, roles.find((r) => r.id === m.roleId)!].filter(Boolean)).map((r) => ({
                      value: r.id,
                      label: r.name,
                      description: r.description ?? undefined,
                      disabled: !options.some((o) => o.id === r.id),
                    }))}
                    className="w-36"
                  />
                ) : (
                  <Badge tone={m.role === "owner" ? "accent" : "neutral"}>{roleName(m.roleId)}</Badge>
                )}
                {(canChange(m) || m.userId === me || (canResetPasswords && m.userId !== me)) && (
                  <Menu>
                    <MenuTrigger className="rounded-lg p-1.5 text-muted hover:bg-hover hover:text-fg" aria-label="Member actions">
                      <MoreHorizontal className="size-4" />
                    </MenuTrigger>
                    <MenuContent>
                      {canChange(m) && m.role === "member" && (
                        <MenuItem onClick={() => setAccess(m)}>
                          <FolderLock /> Project access…
                        </MenuItem>
                      )}
                      {canResetPasswords && m.userId !== me && (
                        <MenuItem
                          onClick={async () => {
                            const res = await makeResetLink.run(m.userId);
                            if (res) setResetLink({ name: m.name, url: res.url });
                          }}
                        >
                          <KeyRound /> Create password reset link
                        </MenuItem>
                      )}
                      {(canChange(m) || m.userId === me) && (
                        <>
                          {(canChange(m) || canResetPasswords) && m.userId !== me && <MenuSeparator />}
                          <MenuItem
                            danger
                            onClick={async () => {
                              const self = m.userId === me;
                              if (
                                await confirm({
                                  title: self ? "Leave this organization?" : `Remove ${m.name}?`,
                                  description: self ? "You lose access to its projects." : "They lose access to all projects in this organization.",
                                  confirmLabel: self ? "Leave" : "Remove",
                                  danger: true,
                                })
                              )
                                remove.run(m.id);
                            }}
                          >
                            {m.userId === me ? (
                              <>
                                <LogOut /> Leave organization
                              </>
                            ) : (
                              <>
                                <Trash2 /> Remove member
                              </>
                            )}
                          </MenuItem>
                        </>
                      )}
                    </MenuContent>
                  </Menu>
                )}
              </div>
            );
          })}
        </div>
      </Card>

      {invitations.length > 0 && (
        <Card className="overflow-hidden">
          <CardHeader title="Pending invitations" description="Share the link with the person you invited. Links expire after 7 days." />
          <div className="divide-y divide-line">
            {invitations.map((i) => (
              <div key={i.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
                <span className="flex size-8 items-center justify-center rounded-full border border-dashed border-line-strong text-faint">
                  <Mail className="size-3.5" />
                </span>
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-[14px] text-fg">{i.email}</span>
                  <span className="text-xs text-muted">
                    {roleName(i.roleId)} · expires <TimeAgo date={i.expiresAt} />
                  </span>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={async () => {
                    if (await copyText(inviteLink(i.id))) toast.success("Invite link copied");
                    else toast.error(`Could not copy. The invite link is ${inviteLink(i.id)}`);
                  }}
                >
                  <Link2 /> Copy link
                </Button>
                {canManage && (
                  <Button size="sm" variant="danger-ghost" onClick={() => revoke.run(i.id)}>
                    Revoke
                  </Button>
                )}
              </div>
            ))}
          </div>
        </Card>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (link) setOpen(false);
              else void invite.run();
            }}
          >
            <DialogHeader
              title="Invite someone"
              description={`${emailEnabled ? "They get an email with a link to create an account or sign in and join." : "They get a link to create an account or sign in and join."}${addsDirectly ? " Someone who already has an account is added at once." : ""}`}
            />
            <DialogBody>
              {link ? (
                <>
                  {sent?.ok && <p className="rounded-xl border border-ok/25 bg-ok-soft px-3.5 py-2.5 text-[13px] text-fg-2">Invitation emailed to {email}.</p>}
                  {sent && !sent.ok && (
                    <p className="rounded-xl border border-warn/25 bg-warn-soft px-3.5 py-2.5 text-[13px] text-fg-2">
                      The email could not be sent ({sent.error}). Share the link instead.
                    </p>
                  )}
                  <Field label="Invite link" description={`${sent?.ok ? "You can also share this link" : `Send this link to ${email}`}. It works once and expires in 7 days.`}>
                    <CopyField value={link} />
                  </Field>
                </>
              ) : (
                <>
                  <Field label="Email">
                    <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus placeholder="teammate@company.com" />
                  </Field>
                  <Field label="Role" description="You can limit them to some projects after they join.">
                    <Select value={roleId} onValueChange={setRoleId} options={options.map((r) => ({ value: r.id, label: r.name, description: r.description ?? undefined }))} />
                  </Field>
                </>
              )}
            </DialogBody>
            <DialogFooter>
              {!link && <DialogClose render={<Button variant="ghost" size="sm" />}>Cancel</DialogClose>}
              <Button type="submit" variant="primary" size="sm" loading={invite.pending}>
                {link ? "Done" : emailEnabled ? "Send invitation" : "Create invite link"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {access && <ProjectAccessDialog member={access} projects={projects} onClose={() => setAccess(null)} />}

      <Dialog open={!!resetLink} onOpenChange={(o) => !o && setResetLink(null)}>
        <DialogContent>
          <DialogHeader
            title={`Password reset link for ${resetLink?.name ?? ""}`}
            description="Send it to them privately. It works once and expires in 1 hour. Using it signs them out everywhere."
          />
          <DialogBody>{resetLink && <CopyField value={resetLink.url} />}</DialogBody>
          <DialogFooter>
            <DialogClose render={<Button variant="primary" size="sm" />}>Done</DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** Choose which projects a member reaches: all of them, or a list. */
function ProjectAccessDialog({ member, projects, onClose }: { member: Member; projects: { id: string; name: string }[]; onClose: () => void }) {
  const [all, setAll] = React.useState(!member.projectIds);
  const [chosen, setChosen] = React.useState<Set<string>>(new Set(member.projectIds ?? []));
  const save = useAction(() => setMemberProjects(member.id, all ? null : [...chosen]), { success: "Project access updated", onSuccess: onClose });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader
          title={`Project access for ${member.name}`}
          description="They only see and change the projects you choose. Their role still decides what they can do there."
        />
        <DialogBody>
          <div className="flex items-center justify-between gap-3 rounded-xl border border-line px-3.5 py-3">
            <div>
              <p className="text-[13px] font-medium text-fg">All projects</p>
              <p className="text-xs text-muted">Including projects created later.</p>
            </div>
            <Switch checked={all} onCheckedChange={setAll} />
          </div>
          {!all && (
            <div className="flex max-h-72 flex-col divide-y divide-line overflow-y-auto rounded-xl border border-line">
              {projects.length === 0 && <p className="px-3.5 py-3 text-[13px] text-muted">No projects yet.</p>}
              {projects.map((p) => (
                <label key={p.id} className="flex cursor-pointer items-center gap-3 px-3.5 py-2.5 text-[13px] text-fg hover:bg-hover">
                  <Checkbox
                    checked={chosen.has(p.id)}
                    onCheckedChange={(c) =>
                      setChosen((s) => {
                        const n = new Set(s);
                        if (c) n.add(p.id);
                        else n.delete(p.id);
                        return n;
                      })
                    }
                  />
                  <span className="truncate">{p.name}</span>
                </label>
              ))}
            </div>
          )}
        </DialogBody>
        <DialogFooter>
          <DialogClose render={<Button variant="ghost" size="sm" />}>Cancel</DialogClose>
          <Button variant="primary" size="sm" onClick={() => save.run()} loading={save.pending} disabled={!all && chosen.size === 0}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
