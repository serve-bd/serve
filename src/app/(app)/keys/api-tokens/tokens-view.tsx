"use client";

import * as React from "react";
import { AlertTriangle, KeyRound, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardBody, CardHeader, CopyButton, CopyField, EmptyState, TimeAgo } from "@/components/ui/misc";
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
import { API_SCOPES, EXPIRY_OPTIONS, impliedScopes, SCOPE_INFO, type ApiScope } from "@/lib/api-scopes";
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
};
type Project = { id: string; name: string };

const ENDPOINTS: { method: string; path: string; scope: ApiScope; description: string }[] = [
  { method: "GET", path: "/api/v1/services", scope: "read", description: "List services" },
  { method: "GET", path: "/api/v1/services/:id", scope: "read", description: "Service details, domains and variable names" },
  { method: "GET", path: "/api/v1/deployments/:id", scope: "read", description: "Deployment status and log tail" },
  { method: "GET", path: "/api/v1/services/:id/env", scope: "read:sensitive", description: "Variable values" },
  { method: "POST", path: "/api/v1/services/:id/deploy", scope: "deploy", description: "Deploy the latest version" },
  { method: "POST", path: "/api/v1/services/:id/restart", scope: "deploy", description: "Restart (also start, stop)" },
  { method: "PATCH", path: "/api/v1/services/:id/env", scope: "write", description: "Set or remove variables" },
];

const DAY = 86_400_000;

function expiryState(expiresAt: string | null, now: number | null) {
  if (!expiresAt || now === null) return null;
  const days = Math.ceil((new Date(expiresAt).getTime() - now) / DAY);
  if (days <= 0) return { tone: "bad" as const, label: "Expired" };
  return { tone: days <= 7 ? ("warn" as const) : ("neutral" as const), label: `Expires in ${days} day${days === 1 ? "" : "s"}` };
}

function ScopeBadges({ scopes }: { scopes: string[] }) {
  return (
    <span className="flex flex-wrap gap-1">
      {scopes.map((s) => (
        <Badge key={s} tone={s === "admin" ? "bad" : s === "write" || s === "read:sensitive" ? "warn" : s === "deploy" ? "accent" : "neutral"}>
          {SCOPE_INFO[s as ApiScope]?.label ?? s}
        </Badge>
      ))}
    </span>
  );
}

function TokenRow({ token: t, projects, isAdmin, onRevoke }: { token: Token; projects: Project[]; isAdmin: boolean; onRevoke: () => void }) {
  const now = useNow();
  const expiry = expiryState(t.expiresAt, now);
  const expired = expiry?.tone === "bad";
  const projectNames = t.projectIds?.length ? t.projectIds.map((id) => projects.find((p) => p.id === id)?.name ?? "Deleted project") : null;

  return (
    <div className={cn("flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:gap-4", expired && "bg-bad-soft/30")}>
      <div className="flex min-w-0 flex-1 items-start gap-3.5">
        <span className={cn("mt-0.5 flex size-9 flex-none items-center justify-center rounded-[10px] border", expired ? "border-bad/20 bg-bad-soft text-bad" : "border-line bg-surface-2 text-fg-2")}>
          <KeyRound className="size-4" />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
            <span className="truncate text-[14px] font-medium text-fg">{t.name}</span>
            {expiry && <Badge tone={expiry.tone}>{expiry.label}</Badge>}
            {!t.expiresAt && <span className="text-xs text-faint">No expiry</span>}
          </div>
          <ScopeBadges scopes={t.scopes} />
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
        {isAdmin && (
          <Button size="icon-sm" variant="ghost" aria-label={`Revoke ${t.name}`} onClick={onRevoke}>
            <Trash2 />
          </Button>
        )}
      </div>
    </div>
  );
}

function CreateTokenDialog({ open, onOpenChange, projects, baseUrl }: { open: boolean; onOpenChange: (open: boolean) => void; projects: Project[]; baseUrl: string }) {
  const [name, setName] = React.useState("");
  const [expiry, setExpiry] = React.useState("90");
  const [scopes, setScopes] = React.useState<ApiScope[]>(["read", "deploy"]);
  const [restrict, setRestrict] = React.useState(false);
  const [projectIds, setProjectIds] = React.useState<string[]>([]);
  const [created, setCreated] = React.useState<string | null>(null);
  const implied = impliedScopes(scopes);
  const create = useAction(
    () =>
      createApiToken({
        name,
        scopes,
        expiresInDays: expiry === "never" ? null : Number(expiry),
        projectIds: restrict ? projectIds : null,
      }),
    { onSuccess: (d) => setCreated(d.token) },
  );
  const canCreate = name.trim() && scopes.length && (!restrict || projectIds.length);
  const toggleScope = (s: ApiScope, on: boolean) => setScopes((all) => (on ? [...all, s] : all.filter((x) => x !== s)));

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
                  <span className="text-[13px] font-medium text-fg">Permissions</span>
                  <div className="divide-y divide-line overflow-hidden rounded-xl border border-line">
                    {API_SCOPES.map((s) => {
                      const locked = implied.has(s);
                      const checked = locked || scopes.includes(s);
                      return (
                        <label key={s} className={cn("flex cursor-pointer items-start gap-3 px-3.5 py-3 transition-colors hover:bg-hover", locked && "cursor-default hover:bg-transparent")}>
                          <Checkbox checked={checked} disabled={locked} onCheckedChange={(on) => toggleScope(s, on)} className="mt-0.5" />
                          <span className="flex min-w-0 flex-col gap-0.5">
                            <span className="flex items-center gap-2 text-[13px] font-medium text-fg">
                              {SCOPE_INFO[s].label}
                              {locked && <span className="text-[11px] font-normal text-faint">Included</span>}
                            </span>
                            <span className="text-[12.5px] leading-snug text-muted">{SCOPE_INFO[s].description}</span>
                          </span>
                        </label>
                      );
                    })}
                  </div>
                  {(scopes.includes("admin") || scopes.includes("read:sensitive")) && (
                    <p className="flex items-start gap-2 text-[12.5px] text-warn">
                      <AlertTriangle className="mt-0.5 size-3.5 flex-none" /> This token can read secrets. Keep it out of logs and public repositories.
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
                        onClick={() => setRestrict(o.value)}
                        className={cn(
                          "flex flex-col gap-0.5 rounded-xl border px-3.5 py-2.5 text-left transition-colors",
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
                          <Checkbox
                            checked={projectIds.includes(p.id)}
                            onCheckedChange={(on) => setProjectIds((all) => (on ? [...all, p.id] : all.filter((x) => x !== p.id)))}
                          />
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

export function TokensView({ tokens, projects, isAdmin, baseUrl }: { tokens: Token[]; projects: Project[]; isAdmin: boolean; baseUrl: string }) {
  const confirm = useConfirm();
  const [dialog, setDialog] = React.useState(0);
  const [open, setOpen] = React.useState(false);
  const revoke = useAction(revokeApiToken, { success: "Token revoked" });

  return (
    <div className="flex flex-col gap-6">
      <Card className="overflow-hidden">
        <CardHeader
          title="Tokens"
          description={`${tokens.length} token${tokens.length === 1 ? "" : "s"} for this organization`}
          actions={
            isAdmin && (
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
            )
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
                isAdmin={isAdmin}
                onRevoke={async () => {
                  if (await confirm({ title: `Revoke ${t.name}?`, description: "Anything using this token stops working right away.", confirmLabel: "Revoke token", danger: true })) revoke.run(t.id);
                }}
              />
            ))}
          </div>
        )}
      </Card>

      <Card className="overflow-hidden">
        <CardHeader title="Using the API" description="Send the token as a bearer token. Responses are JSON." />
        <CardBody className="flex flex-col gap-4 py-5">
          <pre className="scrollbar-thin overflow-x-auto rounded-xl bg-log-bg p-4 font-mono text-[12px] leading-relaxed text-log-fg">{`curl -X POST \\\n  -H "Authorization: Bearer $SERVE_TOKEN" \\\n  ${baseUrl}/api/v1/services/<service-id>/deploy`}</pre>
          <div className="divide-y divide-line overflow-hidden rounded-xl border border-line">
            {ENDPOINTS.map((e) => (
              <div key={`${e.method} ${e.path}`} className="flex flex-col gap-1 px-3.5 py-2.5 sm:flex-row sm:items-center sm:gap-3">
                <span className="flex min-w-0 items-center gap-2">
                  <span className="w-12 flex-none font-mono text-[11px] font-semibold text-accent">{e.method}</span>
                  <code className="truncate font-mono text-[12px] text-fg">{e.path}</code>
                </span>
                <span className="flex min-w-0 flex-1 items-center justify-between gap-3 pl-14 sm:pl-0">
                  <span className="truncate text-[12.5px] text-muted">{e.description}</span>
                  <Badge tone="neutral" className="flex-none">
                    {SCOPE_INFO[e.scope].label}
                  </Badge>
                </span>
              </div>
            ))}
          </div>
        </CardBody>
      </Card>

      <CreateTokenDialog key={dialog} open={open} onOpenChange={setOpen} projects={projects} baseUrl={baseUrl} />
    </div>
  );
}
