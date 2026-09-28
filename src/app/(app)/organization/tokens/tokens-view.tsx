"use client";

import * as React from "react";
import { KeyRound, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader, CopyField, EmptyState, TimeAgo } from "@/components/ui/misc";
import { Dialog, DialogBody, DialogClose, DialogContent, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { useConfirm } from "@/components/ui/confirm";
import { useAction } from "@/hooks/use-action";
import { createApiToken, revokeApiToken } from "@/server/actions/org";

type Token = { id: string; name: string; prefix: string; lastUsedAt: string | null; createdAt: string; userName: string };

export function TokensView({ tokens, isAdmin, baseUrl }: { tokens: Token[]; isAdmin: boolean; baseUrl: string }) {
  const confirm = useConfirm();
  const [open, setOpen] = React.useState(false);
  const [name, setName] = React.useState("");
  const [created, setCreated] = React.useState<string | null>(null);
  const create = useAction(() => createApiToken(name), { onSuccess: (d) => setCreated(d.token) });
  const revoke = useAction(revokeApiToken, { success: "Token revoked" });

  return (
    <div className="flex flex-col gap-6">
      <Card className="overflow-hidden">
        <CardHeader title="Tokens" actions={isAdmin && <Button size="sm" variant="primary" onClick={() => { setCreated(null); setName(""); setOpen(true); }}><Plus /> Create token</Button>} />
        {tokens.length === 0 ? (
          <EmptyState icon={<KeyRound />} title="No API tokens" description="Tokens act on behalf of this organization." />
        ) : (
          <div className="divide-y divide-line">
            {tokens.map((t) => (
              <div key={t.id} className="flex items-center gap-3 px-5 py-3">
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="text-[14px] font-medium text-fg">{t.name}</span>
                  <span className="text-xs text-muted">
                    <code className="font-mono">{t.prefix}…</code> · by {t.userName} · {t.lastUsedAt ? <>used <TimeAgo date={t.lastUsedAt} /></> : "never used"}
                  </span>
                </div>
                {isAdmin && (
                  <Button size="icon-sm" variant="ghost" aria-label="Revoke" onClick={async () => { if (await confirm({ title: `Revoke ${t.name}?`, description: "Anything using this token stops working.", confirmLabel: "Revoke", danger: true })) revoke.run(t.id); }}>
                    <Trash2 />
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>
      <Card>
        <CardHeader title="Using the API" description="Send the token as a bearer token." />
        <CardBody>
          <pre className="overflow-x-auto rounded-xl bg-log-bg p-4 font-mono text-[12px] leading-relaxed text-log-fg">{`# List services
curl -H "Authorization: Bearer $SERVE_TOKEN" ${baseUrl}/api/v1/services

# Deploy a service
curl -X POST -H "Authorization: Bearer $SERVE_TOKEN" ${baseUrl}/api/v1/services/<service-id>/deploy

# Check a deployment
curl -H "Authorization: Bearer $SERVE_TOKEN" ${baseUrl}/api/v1/deployments/<deployment-id>`}</pre>
        </CardBody>
      </Card>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <form onSubmit={(e) => { e.preventDefault(); if (created) setOpen(false); else void create.run(); }}>
            <DialogHeader title={created ? "Copy your token" : "Create API token"} description={created ? "You won't see it again." : undefined} />
            <DialogBody>
              {created ? <CopyField value={created} /> : <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} required autoFocus placeholder="GitHub Actions" /></Field>}
            </DialogBody>
            <DialogFooter>
              {!created && <DialogClose render={<Button variant="ghost" size="sm" />}>Cancel</DialogClose>}
              <Button type="submit" variant="primary" size="sm" loading={create.pending}>{created ? "Done" : "Create token"}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
