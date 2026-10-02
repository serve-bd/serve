"use client";

import * as React from "react";
import { AlertTriangle, BookOpen, KeyRound, Plus, Trash2 } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Badge, Card, CardHeader, CopyButton, CopyField, EmptyState, TimeAgo } from "@/components/ui/misc";
import { Dialog, DialogBody, DialogClose, DialogContent, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Tooltip } from "@/components/ui/tooltip";
import { useConfirm } from "@/components/ui/confirm";
import { useAction } from "@/hooks/use-action";
import { useNow } from "@/hooks/use-client";
import { createApiToken, revokeApiToken } from "@/server/actions/org";
import { ADMIN_GRANT_INFO, EXPIRY_OPTIONS, normalizeGrants, TOKEN_PRESETS, tokenGrants, type TokenGrant } from "@/lib/api-scopes";
import { PERMISSION_GROUPS, PERMISSION_INFO, PERMISSIONS, type Permission } from "@/lib/permissions";
import { cn } from "@/lib/utils";

type Token = {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  projectIds: string[] | null;
  expiresAt: string | null;
  lastUsedAt: string | null;
  lastUsedIp: string | null;
  createdAt: string;
  userName: string;
  userId: string;
};
type Project = { id: string; name: string };

const SENSITIVE: Permission[] = ["variables.view-secrets", "console.access", "members.manage", "integrations.manage"];

const DAY = 86_400_000;

function expiryState(expiresAt: string | null, now: number | null) {
  if (!expiresAt || now === null) return null;
  const days = Math.ceil((new Date(expiresAt).getTime() - now) / DAY);
  if (days <= 0) return { tone: "bad" as const, label: "Expired" };
  return { tone: days <= 7 ? ("warn" as const) : ("neutral" as const), label: `Expires in ${days} day${days === 1 ? "" : "s"}` };
}

function GrantBadges({ scopes }: { scopes: string[] }) {
  const { permissions, admin } = tokenGrants(scopes);
  if (admin)
    return (
      <span className="flex">
        <Badge tone="bad">{ADMIN_GRANT_INFO.label}</Badge>
      </span>
    );
  const list = PERMISSIONS.filter((p) => permissions.has(p));
  return (
    <span className="flex flex-wrap gap-1">
      {list.map((p) => (
        <Badge key={p} tone={SENSITIVE.includes(p) ? "warn" : p === "services.deploy" ? "accent" : "neutral"}>
          {PERMISSION_INFO[p].label}
        </Badge>
      ))}
    </span>
  );
}

function TokenRow({ token: t, projects, canRevoke, onRevoke }: { token: Token; projects: Project[]; canRevoke: boolean; onRevoke: () => void }) {
  const now = useNow();
  const expiry = expiryState(t.expiresAt, now);
  const expired = expiry?.tone === "bad";
  const projectNames = t.projectIds?.length ? t.projectIds.map((id) => projects.find((p) => p.id === id)?.name ?? "Deleted project") : null;

  return (
    <div className={cn("flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:gap-4", expired && "bg-bad-soft/30")}>
      <div className="flex min-w-0 flex-1 items-start gap-3.5">
        <span
          className={cn(
            "mt-0.5 flex size-9 flex-none items-center justify-center rounded-[10px] border",
            expired ? "border-bad/20 bg-bad-soft text-bad" : "border-line bg-surface-2 text-fg-2",
          )}
        >
          <KeyRound className="size-4" />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
            <span className="truncate text-[14px] font-medium text-fg">{t.name}</span>
            {expiry && <Badge tone={expiry.tone}>{expiry.label}</Badge>}
            {!t.expiresAt && <span className="text-xs text-faint">No expiry</span>}
          </div>
          <GrantBadges scopes={t.scopes} />
          <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-muted">
            <code className="font-mono text-[11.5px] text-fg-2">{t.prefix}…</code>
            <span className="text-faint">·</span>
            <span className="truncate">{projectNames ? projectNames.join(", ") : "All projects"}</span>
          </div>
          <span className="text-xs text-faint">
            Created by {t.userName} <TimeAgo date={t.createdAt} />
          </span>
        </div>
      </div>
      <div className="flex flex-none items-center justify-between gap-3 pl-[50px] sm:justify-end sm:pl-0">
        <span className="text-xs text-muted">
          {t.lastUsedAt ? (
            <Tooltip content={t.lastUsedIp ? `From ${t.lastUsedIp}` : "Last request"}>
              <span>
                Used <TimeAgo date={t.lastUsedAt} />
              </span>
            </Tooltip>
          ) : (
            "Never used"
          )}
        </span>
        {canRevoke && (
          <Button size="icon-sm" variant="ghost" aria-label={`Revoke ${t.name}`} onClick={onRevoke}>
            <Trash2 />
          </Button>
        )}
      </div>
    </div>
  );
}

function CreateTokenDialog({
  open,
  onOpenChange,
  projects,
  baseUrl,
  allowed,
  limitedToProjects,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projects: Project[];
  baseUrl: string;
  allowed: TokenGrant[];
  limitedToProjects: boolean;
}) {
  const [name, setName] = React.useState("");
  const [expiry, setExpiry] = React.useState("90");
  const [grants, setGrants] = React.useState<TokenGrant[]>(() => (["projects.view", "logs.view", "services.deploy"] as TokenGrant[]).filter((s) => allowed.includes(s)));
  const admin = grants.includes("admin");
  // Members limited to some projects always pick projects.
  const [restrict, setRestrict] = React.useState(limitedToProjects);
  const [projectIds, setProjectIds] = React.useState<string[]>([]);
  const [created, setCreated] = React.useState<string | null>(null);
  const create = useAction(
    () =>
      createApiToken({
        name,
        scopes: normalizeGrants(grants),
        expiresInDays: expiry === "never" ? null : Number(expiry),
        projectIds: restrict ? projectIds : null,
      }),
    { onSuccess: (d) => setCreated(d.token) },
  );
  const canCreate = name.trim() && grants.length && (!restrict || projectIds.length);
  const toggle = (g: TokenGrant, on: boolean) => setGrants((all) => (on ? [...all, g] : all.filter((x) => x !== g)));
  const preset = TOKEN_PRESETS.find((p) => p.grants.length === grants.length && p.grants.every((g) => grants.includes(g)))?.id ?? null;
  const reads = admin || grants.some((g) => SENSITIVE.includes(g as Permission));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (created) onOpenChange(false);
            else if (canCreate) void create.run();
          }}
        >
          <DialogHeader
            title={created ? "Copy your token" : "Create API token"}
            description={created ? "Store it somewhere safe. You won't see it again." : "Give the token only the permissions it needs."}
          />
          <DialogBody className="flex flex-col gap-5">
            {created ? (
              <>
                <CopyField value={created} />
                <div className="flex flex-col gap-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-muted">Try it</span>
                    <CopyButton value={`curl -H "Authorization: Bearer ${created}" ${baseUrl}/api/v1/services`} />
                  </div>
                  <pre className="scrollbar-thin overflow-x-auto rounded-xl bg-log-bg p-3.5 font-mono text-[12px] leading-relaxed text-log-fg">{`curl -H "Authorization: Bearer ${created.slice(0, 10)}…" \\\n  ${baseUrl}/api/v1/services`}</pre>
                </div>
              </>
            ) : (
              <>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-[minmax(0,1fr)_180px]">
                  <Field label="Name">
                    <Input value={name} onChange={(e) => setName(e.target.value)} required autoFocus placeholder="GitHub Actions deploy" maxLength={60} />
                  </Field>
                  <Field label="Expires in">
                    <Select value={expiry} onValueChange={setExpiry} options={EXPIRY_OPTIONS.map((o) => ({ value: o.value, label: o.label }))} />
                  </Field>
                </div>

                <div className="flex flex-col gap-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-[13px] font-medium text-fg">Permissions</span>
                    <div className="flex flex-wrap gap-1">
                      {TOKEN_PRESETS.filter((p) => p.grants.every((g) => allowed.includes(g))).map((p) => (
                        <button
                          key={p.id}
                          type="button"
                          onClick={() => setGrants(p.grants)}
                          className={cn(
                            "rounded-full border px-2.5 py-0.5 text-[12px] transition-colors",
                            preset === p.id ? "border-accent bg-accent-soft/60 text-fg" : "border-line text-muted hover:bg-hover hover:text-fg",
                          )}
                        >
                          {p.label}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="scrollbar-thin max-h-[340px] divide-y divide-line overflow-y-auto rounded-xl border border-line">
                    {allowed.includes("admin") && (
                      <label className="flex cursor-pointer items-start gap-3 px-3.5 py-3 transition-colors hover:bg-hover">
                        <Checkbox checked={admin} onCheckedChange={(on) => setGrants(on ? ["admin"] : [])} className="mt-0.5" />
                        <span className="flex min-w-0 flex-col gap-0.5">
                          <span className="text-[13px] font-medium text-fg">{ADMIN_GRANT_INFO.label}</span>
                          <span className="text-[12.5px] leading-snug text-muted">{ADMIN_GRANT_INFO.description}</span>
                        </span>
                      </label>
                    )}
                    {PERMISSION_GROUPS.map((group) => (
                      <div key={group.title} className="flex flex-col py-1.5">
                        <span className="px-3.5 pt-1.5 pb-1 text-[11px] font-medium tracking-wide text-faint uppercase">{group.title}</span>
                        {group.permissions.map((p) => {
                          const denied = !allowed.includes(p);
                          const checked = admin || (!denied && grants.includes(p));
                          return (
                            <label
                              key={p}
                              className={cn(
                                "flex cursor-pointer items-start gap-3 px-3.5 py-2 transition-colors hover:bg-hover",
                                (denied || admin) && "cursor-default hover:bg-transparent",
                              )}
                            >
                              <Checkbox checked={checked} disabled={denied || admin} onCheckedChange={(on) => toggle(p, on)} className="mt-0.5" />
                              <span className="flex min-w-0 flex-col gap-0.5">
                                <span className="flex items-center gap-2 text-[13px] font-medium text-fg">
                                  {PERMISSION_INFO[p].label}
                                  {denied && <span className="text-[11px] font-normal text-faint">Your role does not allow it</span>}
                                </span>
                                <span className="text-[12.5px] leading-snug text-muted">{PERMISSION_INFO[p].description}</span>
                              </span>
                            </label>
                          );
                        })}
                      </div>
                    ))}
                  </div>
                  {reads && (
                    <p className="flex items-start gap-2 text-[12.5px] text-warn">
                      <AlertTriangle className="mt-0.5 size-3.5 flex-none" /> This token can read secrets or change who has access. Keep it out of logs and public repositories.
                    </p>
                  )}
                </div>

                <div className="flex flex-col gap-2">
                  <span className="text-[13px] font-medium text-fg">Projects</span>
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    {[
                      { value: false, title: "All projects", description: "Including projects created later." },
                      { value: true, title: "Selected projects", description: "Other projects return 404." },
                    ].map((o) => (
                      <button
                        key={String(o.value)}
                        type="button"
                        disabled={limitedToProjects && !o.value}
                        title={limitedToProjects && !o.value ? "Your access is limited to some projects." : undefined}
                        onClick={() => setRestrict(o.value)}
                        className={cn(
                          "flex flex-col gap-0.5 rounded-xl border px-3.5 py-2.5 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50",
                          restrict === o.value ? "border-accent bg-accent-soft/50 ring-1 ring-accent" : "border-line hover:bg-hover",
                        )}
                      >
                        <span className="text-[13px] font-medium text-fg">{o.title}</span>
                        <span className="text-[12px] text-muted">{o.description}</span>
                      </button>
                    ))}
                  </div>
                  {restrict && (
                    <div className="scrollbar-thin flex max-h-44 flex-col overflow-y-auto rounded-xl border border-line p-1">
                      {projects.length === 0 && <p className="px-2.5 py-2 text-[13px] text-muted">No projects yet.</p>}
                      {projects.map((p) => (
                        <label key={p.id} className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] text-fg-2 hover:bg-hover">
                          <Checkbox checked={projectIds.includes(p.id)} onCheckedChange={(on) => setProjectIds((all) => (on ? [...all, p.id] : all.filter((x) => x !== p.id)))} />
                          <span className="truncate">{p.name}</span>
                        </label>
                      ))}
                    </div>
                  )}
                </div>
              </>
            )}
          </DialogBody>
          <DialogFooter>
            {!created && <DialogClose render={<Button variant="ghost" size="sm" />}>Cancel</DialogClose>}
            <Button type="submit" variant="primary" size="sm" loading={create.pending} disabled={!created && !canCreate}>
              {created ? "Done" : "Create token"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function TokensView({
  tokens,
  projects,
  canManage,
  me,
  allowed,
  limitedToProjects,
  baseUrl,
}: {
  tokens: Token[];
  projects: Project[];
  /** Sees and revokes every token of the organization. */
  canManage: boolean;
  me: string;
  /** Permissions the member's role allows; a token cannot have more. */
  allowed: TokenGrant[];
  limitedToProjects: boolean;
  baseUrl: string;
}) {
  const confirm = useConfirm();
  const [dialog, setDialog] = React.useState(0);
  const [open, setOpen] = React.useState(false);
  const revoke = useAction(revokeApiToken);

  return (
    <div className="flex flex-col gap-6">
      <Card className="overflow-hidden">
        <CardHeader
          title="Tokens"
          description={`${tokens.length} token${tokens.length === 1 ? "" : "s"} for this organization`}
          actions={
            <div className="flex items-center gap-2">
              <a href="https://serve.bd/docs/api" target="_blank" rel="noreferrer" className={buttonVariants({ variant: "ghost", size: "sm" })}>
                <BookOpen /> API docs
              </a>
              <Button
                size="sm"
                variant="primary"
                onClick={() => {
                  setDialog((d) => d + 1);
                  setOpen(true);
                }}
              >
                <Plus /> Create token
              </Button>
            </div>
          }
        />
        {tokens.length === 0 ? (
          <EmptyState icon={<KeyRound />} title="No API tokens" description="Create a token to deploy from CI, scripts or other tools." />
        ) : (
          <div className="divide-y divide-line">
            {tokens.map((t) => (
              <TokenRow
                key={t.id}
                token={t}
                projects={projects}
                canRevoke={canManage || t.userId === me}
                onRevoke={async () => {
                  if (await confirm({ title: `Revoke ${t.name}?`, description: "Anything using this token stops working right away.", confirmLabel: "Revoke token", danger: true }))
                    revoke.run(t.id);
                }}
              />
            ))}
          </div>
        )}
      </Card>

      <CreateTokenDialog key={dialog} open={open} onOpenChange={setOpen} projects={projects} baseUrl={baseUrl} allowed={allowed} limitedToProjects={limitedToProjects} />
    </div>
  );
}
