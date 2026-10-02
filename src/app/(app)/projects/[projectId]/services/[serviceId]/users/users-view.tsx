"use client";

import * as React from "react";
import { KeyRound, Link2, Lock, MoreHorizontal, Plus, ShieldCheck, Trash2, UserRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { Badge, Card, CardHeader, CopyField, EmptyState } from "@/components/ui/misc";
import { Checkbox } from "@/components/ui/checkbox";
import { useAction } from "@/hooks/use-action";
import { cn } from "@/lib/utils";
import { changeDatabaseUserPassword, createDatabaseUser, databaseUserUrls, deleteDatabaseUser, setDatabaseUserAccess, type DatabaseUserRow } from "@/server/actions/database-users";
import type { DatabaseUserAccess } from "@/server/db/schema";

type Credentials = { username: string; password: string; privateUrl: string; publicUrl: string | null };

const ACCESS: { value: DatabaseUserAccess; label: string; describe: (engine: string) => string }[] = [
  { value: "read", label: "Read only", describe: () => "Reads the data. Cannot change anything." },
  {
    value: "readwrite",
    label: "Read and write",
    describe: (engine) => (engine === "mongodb" ? "Reads, adds, changes and deletes documents." : "Reads, adds, changes and deletes rows. Cannot change tables."),
  },
  {
    value: "owner",
    label: "Full access",
    describe: (engine) =>
      engine === "mongodb"
        ? "Everything in the chosen databases, including collections and indexes."
        : engine === "postgres"
          ? "Reads and writes everything, and makes its own tables. Tables of the main login keep their owner."
          : "Everything in the chosen databases, including making and changing tables.",
  },
];
const accessLabel = (a: DatabaseUserAccess) => ACCESS.find((x) => x.value === a)?.label ?? a;

export function UsersView({
  serviceId,
  serviceName,
  engine,
  running,
  error,
  users,
  databases,
  mainDatabase,
  canManage,
  canSecrets,
}: {
  serviceId: string;
  serviceName: string;
  engine: string;
  running: boolean;
  error: string | null;
  users: DatabaseUserRow[];
  databases: string[];
  mainDatabase: string;
  canManage: boolean;
  canSecrets: boolean;
}) {
  const confirm = useConfirm();
  const [dialog, setDialog] = React.useState<{ mode: "create" } | { mode: "access"; user: DatabaseUserRow } | null>(null);
  const [shown, setShown] = React.useState<{ creds: Credentials; title: string } | null>(null);
  const remove = useAction((name: string) => deleteDatabaseUser(serviceId, name));
  const password = useAction((name: string) => changeDatabaseUserPassword(serviceId, name), {
    onSuccess: (creds) => setShown({ creds, title: `New password for ${creds.username}` }),
  });
  const urls = useAction((name: string) => databaseUserUrls(serviceId, name), { refresh: false, onSuccess: (creds) => setShown({ creds, title: creds.username }) });
  const canAdd = canManage && canSecrets;

  return (
    <div className="flex flex-col gap-6">
      <Card className="overflow-hidden">
        <CardHeader
          title="Users"
          description={`Logins inside ${serviceName}. Give each app or person its own login, with only the access it needs.`}
          actions={
            canAdd && (
              <Button
                size="sm"
                variant="primary"
                disabled={!running || !!error}
                title={running ? undefined : "Start the database to add users"}
                onClick={() => setDialog({ mode: "create" })}
              >
                <Plus /> Add user
              </Button>
            )
          }
        />
        {!running ? (
          <EmptyState icon={<UserRound />} title="The database is not running" description="Users live inside the database. Start it to see and change them." />
        ) : error ? (
          <p className="border-t border-line px-5 py-4 text-sm text-bad">{error}</p>
        ) : (
          <ul className="divide-y divide-line border-t border-line">
            {users.map((u) => {
              const locked = !!u.protectedReason;
              return (
                <li key={u.username} className={cn("flex items-start gap-3 px-4 sm:px-5", locked ? "bg-sunken/40 py-2.5" : "py-3.5")}>
                  {locked ? <Lock className="mt-0.5 size-4 flex-none text-faint" /> : <UserRound className="mt-0.5 size-4 flex-none text-muted" />}
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                      <span className={cn("truncate font-mono", locked ? "text-[12.5px] text-fg-2" : "text-[13.5px] font-medium text-fg")}>{u.username}</span>
                      {u.access && (
                        <Badge tone={u.access === "owner" ? "warn" : u.access === "readwrite" ? "info" : "neutral"}>
                          <ShieldCheck className="size-3" /> {accessLabel(u.access)}
                        </Badge>
                      )}
                    </span>
                    <span className="text-xs text-muted">
                      {u.protectedReason
                        ? `${u.protectedReason}. Not changed here.`
                        : u.access
                          ? `On ${u.databases.join(", ")}`
                          : "Made outside Serve. Its own grants are kept until you change its access."}
                    </span>
                  </div>
                  {!locked && (canManage || (u.knowsPassword && canSecrets)) && (
                    <Menu>
                      <MenuTrigger render={<Button size="icon-sm" variant="ghost" aria-label={`Actions for ${u.username}`} />}>
                        <MoreHorizontal />
                      </MenuTrigger>
                      <MenuContent>
                        {u.knowsPassword && canSecrets && (
                          <MenuItem onClick={() => void urls.run(u.username)}>
                            <Link2 /> Show connection URL
                          </MenuItem>
                        )}
                        {canManage && (
                          <MenuItem onClick={() => setDialog({ mode: "access", user: u })}>
                            <ShieldCheck /> Change access
                          </MenuItem>
                        )}
                        {canAdd && (
                          <MenuItem
                            onClick={async () => {
                              if (
                                await confirm({
                                  title: `New password for ${u.username}?`,
                                  description: "Serve makes a new password. Apps that use the old one cannot log in until you give them the new one.",
                                  confirmLabel: "Change password",
                                })
                              )
                                await password.run(u.username);
                            }}
                          >
                            <KeyRound /> Change password
                          </MenuItem>
                        )}
                        {canManage && (
                          <>
                            <MenuSeparator />
                            <MenuItem
                              danger
                              onClick={async () => {
                                if (
                                  await confirm({
                                    title: `Delete ${u.username}?`,
                                    description:
                                      engine === "postgres"
                                        ? "The login is removed and its sessions end. Tables it made are kept and given to the main login."
                                        : "The login is removed. Apps that use it cannot connect any more. The data stays.",
                                    confirmLabel: "Delete user",
                                    danger: true,
                                  })
                                )
                                  await remove.run(u.username);
                              }}
                            >
                              <Trash2 /> Delete
                            </MenuItem>
                          </>
                        )}
                      </MenuContent>
                    </Menu>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Card>
      <p className="px-1 text-xs leading-relaxed text-muted">
        Serve keeps the password of each user it makes, so you can copy its connection URL later. Logins of branches and Serve&apos;s own login are managed on their own pages.
      </p>
      {dialog && (
        <UserDialog
          serviceId={serviceId}
          engine={engine}
          databases={databases}
          mainDatabase={mainDatabase}
          user={dialog.mode === "access" ? dialog.user : null}
          onClose={() => setDialog(null)}
          onCreated={(creds) => setShown({ creds, title: `${creds.username} is ready` })}
        />
      )}
      {shown && <CredentialsDialog title={shown.title} creds={shown.creds} onClose={() => setShown(null)} />}
    </div>
  );
}

function UserDialog({
  serviceId,
  engine,
  databases,
  mainDatabase,
  user,
  onClose,
  onCreated,
}: {
  serviceId: string;
  engine: string;
  databases: string[];
  mainDatabase: string;
  user: DatabaseUserRow | null;
  onClose: () => void;
  onCreated: (creds: Credentials) => void;
}) {
  const [username, setUsername] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [access, setAccess] = React.useState<DatabaseUserAccess>(user?.access ?? "readwrite");
  const [chosen, setChosen] = React.useState<string[]>(user?.databases.length ? user.databases : databases.includes(mainDatabase) ? [mainDatabase] : databases.slice(0, 1));
  const create = useAction(() => createDatabaseUser(serviceId, { username, password, access, databases: chosen }), {
    onSuccess: (creds) => {
      onClose();
      onCreated(creds);
    },
  });
  const save = useAction(() => setDatabaseUserAccess(serviceId, user!.username, access, chosen), { onSuccess: onClose });
  const pending = create.pending || save.pending;
  const toggle = (d: string, on: boolean) => setChosen((c) => (on ? [...c, d] : c.filter((x) => x !== d)));

  return (
    <Dialog open onOpenChange={(o) => !o && !pending && onClose()}>
      <DialogContent size="sm">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void (user ? save.run() : create.run());
          }}
        >
          <DialogHeader
            title={user ? `Access of ${user.username}` : "Add user"}
            description={user ? "The new access replaces the old one on every database." : "A new login with its own password."}
          />
          <DialogBody className="flex flex-col gap-4">
            {!user && (
              <>
                <Field label="Name" description="Lowercase letters, digits and underscores.">
                  <Input
                    value={username}
                    onChange={(e) => setUsername(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "_"))}
                    placeholder="app_reader"
                    maxLength={32}
                    className="font-mono text-[13px]"
                    spellCheck={false}
                    required
                    autoFocus
                  />
                </Field>
                <Field label="Password" description="Leave it empty and Serve makes a strong one.">
                  <Input
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    type="password"
                    autoComplete="new-password"
                    placeholder="Generate"
                    className="font-mono text-[13px]"
                  />
                </Field>
              </>
            )}
            <div className="flex flex-col gap-1.5">
              <span className="text-[13px] font-medium text-fg">Access</span>
              <div role="radiogroup" aria-label="Access" className="flex flex-col gap-1.5">
                {ACCESS.map((a) => (
                  <button
                    key={a.value}
                    type="button"
                    role="radio"
                    aria-checked={access === a.value}
                    onClick={() => setAccess(a.value)}
                    className={cn(
                      "flex flex-col gap-0.5 rounded-lg border px-3 py-2 text-left transition-colors",
                      access === a.value ? "border-accent bg-accent/5" : "border-line hover:border-line-strong",
                    )}
                  >
                    <span className="text-[13px] font-medium text-fg">{a.label}</span>
                    <span className="text-[12px] leading-snug text-muted">{a.describe(engine)}</span>
                  </button>
                ))}
              </div>
            </div>
            <div className="flex flex-col gap-1.5">
              <span className="text-[13px] font-medium text-fg">Databases</span>
              <div className="flex max-h-44 flex-col gap-2 overflow-y-auto rounded-lg border border-line px-3 py-2.5">
                {databases.length === 0 && <span className="text-[12.5px] text-muted">There are no databases yet.</span>}
                {databases.map((d) => (
                  <label key={d} className="flex cursor-pointer items-center gap-2.5">
                    <Checkbox checked={chosen.includes(d)} onCheckedChange={(on) => toggle(d, on)} />
                    <span className="truncate font-mono text-[12.5px] text-fg-2">{d}</span>
                  </label>
                ))}
              </div>
            </div>
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose} disabled={pending}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" loading={pending} disabled={(!user && !username) || chosen.length === 0}>
              {user ? "Save access" : "Add user"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function CredentialsDialog({ title, creds, onClose }: { title: string; creds: Credentials; onClose: () => void }) {
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="md">
        <DialogHeader title={title} description="Give this to the app that uses the login. You can open it again from the user's menu." />
        <DialogBody className="flex flex-col gap-4">
          <Field label="Password">
            <CopyField value={creds.password} secret />
          </Field>
          <Field label="URL on the private network" description="For services in this project.">
            <CopyField value={creds.privateUrl} secret />
          </Field>
          {creds.publicUrl && (
            <Field label="Public URL" description="Through the public port. Check the IP allowlist.">
              <CopyField value={creds.publicUrl} secret />
            </Field>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
