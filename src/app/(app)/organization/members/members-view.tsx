"use client";

import * as React from "react";
import { useRouter } from "@/hooks/use-router";
import { KeyRound, Link2, LogOut, Mail, MoreHorizontal, Trash2, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Avatar, Badge, Card, CardHeader, CopyField, TimeAgo } from "@/components/ui/misc";
import { Dialog, DialogBody, DialogClose, DialogContent, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu";
import { useConfirm } from "@/components/ui/confirm";
import { toast } from "@/components/ui/toast";
import { useAction } from "@/hooks/use-action";
import { changeMemberRole, inviteMember, removeMember, revokeInvitation } from "@/server/actions/org";
import { createPasswordResetLink } from "@/server/actions/email";
import type { MemberRole } from "@/server/db/schema";

type Member = { id: string; role: string; createdAt: string; userId: string; name: string; email: string; image: string | null };
type Invite = { id: string; email: string; role: string; expiresAt: string };

const roleOptions = [
  { value: "member", label: "Member", description: "Deploy and manage services" },
  { value: "admin", label: "Admin", description: "Manage members and integrations" },
  { value: "owner", label: "Owner", description: "Full control, including deletion" },
];

export function MembersView({
  baseUrl,
  me,
  myRole,
  members,
  invitations,
  emailEnabled = false,
  canResetPasswords = false,
}: {
  baseUrl: string;
  me: string;
  myRole: string;
  members: Member[];
  invitations: Invite[];
  emailEnabled?: boolean;
  /** Root admins can create reset links for instances without email. */
  canResetPasswords?: boolean;
}) {
  const router = useRouter();
  const confirm = useConfirm();
  const isAdmin = myRole === "owner" || myRole === "admin";
  const [open, setOpen] = React.useState(false);
  const [email, setEmail] = React.useState("");
  const [role, setRole] = React.useState<MemberRole>("member");
  const [link, setLink] = React.useState<string | null>(null);
  const [sent, setSent] = React.useState<{ ok: boolean; error: string | null } | null>(null);
  const [resetLink, setResetLink] = React.useState<{ name: string; url: string } | null>(null);
  const inviteLink = (id: string) => `${baseUrl}/invite/${id}`;

  const invite = useAction(() => inviteMember({ email, role }), {
    onSuccess: (d) => {
      setLink(inviteLink(d.id));
      setSent(d.emailed || d.emailError ? { ok: d.emailed, error: d.emailError } : null);
    },
  });
  const makeResetLink = useAction((userId: string) => createPasswordResetLink(userId), { refresh: false });
  const changeRole = useAction((id: string, r: MemberRole) => changeMemberRole(id, r), { success: "Role updated" });
  const remove = useAction(removeMember, {
    onSuccess: (d) => {
      if (d.self) {
        toast.success("You left the organization");
        router.replace("/");
      } else toast.success("Member removed");
    },
  });
  const revoke = useAction(revokeInvitation, { success: "Invitation revoked" });

  return (
    <div className="flex flex-col gap-6">
      <Card className="overflow-hidden">
        <CardHeader
          title={`${members.length} member${members.length === 1 ? "" : "s"}`}
          actions={
            isAdmin && (
              <Button
                size="sm"
                variant="primary"
                onClick={() => {
                  setLink(null);
                  setEmail("");
                  setOpen(true);
                }}
              >
                <UserPlus /> Invite
              </Button>
            )
          }
        />
        <div className="divide-y divide-line">
          {members.map((m) => (
            <div key={m.id} className="flex items-center gap-3 px-5 py-3">
              <Avatar name={m.name} src={m.image} className="size-8" />
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-[14px] font-medium text-fg">
                  {m.name} {m.userId === me && <span className="text-xs font-normal text-muted">(you)</span>}
                </span>
                <span className="truncate text-xs text-muted">
                  {m.email} · joined <TimeAgo date={m.createdAt} />
                </span>
              </div>
              {isAdmin && m.userId !== me ? (
                <Select
                  size="sm"
                  value={m.role}
                  onValueChange={(r) => changeRole.run(m.id, r as MemberRole)}
                  options={roleOptions.filter((o) => myRole === "owner" || o.value !== "owner")}
                  className="w-32"
                />
              ) : (
                <Badge tone={m.role === "owner" ? "accent" : "neutral"} className="capitalize">
                  {m.role}
                </Badge>
              )}
              {(isAdmin || m.userId === me) && (
                <Menu>
                  <MenuTrigger className="rounded-lg p-1.5 text-muted hover:bg-hover hover:text-fg" aria-label="Member actions">
                    <MoreHorizontal className="size-4" />
                  </MenuTrigger>
                  <MenuContent>
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
                  </MenuContent>
                </Menu>
              )}
            </div>
          ))}
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
                  <span className="text-xs text-muted capitalize">
                    {i.role} · expires <TimeAgo date={i.expiresAt} />
                  </span>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={async () => {
                    await navigator.clipboard.writeText(inviteLink(i.id));
                    toast.success("Invite link copied");
                  }}
                >
                  <Link2 /> Copy link
                </Button>
                {isAdmin && (
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
              description={emailEnabled ? "They get an email with a link to create an account or sign in and join." : "They get a link to create an account or sign in and join."}
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
                  <Field label="Role">
                    <Select value={role} onValueChange={(r) => setRole(r as MemberRole)} options={roleOptions.filter((o) => myRole === "owner" || o.value !== "owner")} />
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
