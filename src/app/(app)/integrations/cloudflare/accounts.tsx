"use client";

import * as React from "react";
import Link from "next/link";
import { ChevronRight, Cloud, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardHeader, EmptyState } from "@/components/ui/misc";
import { Dialog, DialogBody, DialogClose, DialogContent, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { useConfirm } from "@/components/ui/confirm";
import { useAction } from "@/hooks/use-action";
import { connectCloudflare, disconnectCloudflare } from "@/server/actions/integrations";
import { PageBody, PageHeader } from "@/components/shell/page-header";

type Account = { id: string; name: string; zones: { id: string; name: string; status: string; plan: string | null }[]; error: string | null };

export function ConnectCloudflareDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [name, setName] = React.useState("");
  const [token, setToken] = React.useState("");
  const [originKey, setOriginKey] = React.useState("");
  const { run, pending } = useAction(() => connectCloudflare({ name, apiToken: token, originCaKey: originKey }), {
    success: (d) => `Connected · ${d.zones} zones`,
    onSuccess: () => {
      onOpenChange(false);
      setToken("");
    },
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void run();
          }}
        >
          <DialogHeader title="Connect Cloudflare" description="Tokens are encrypted and only used for your zones." />
          <DialogBody>
            <Field label="Name" optional>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Company account" />
            </Field>
            <Field
              label="API token"
              description={
                <>
                  Create one at <span className="text-fg-2">dash.cloudflare.com → My Profile → API Tokens</span> with Zone · Read, DNS · Edit, Zone Settings · Edit and SSL and Certificates · Edit.
                </>
              }
            >
              <Input type="password" value={token} onChange={(e) => setToken(e.target.value)} required className="font-mono" autoComplete="off" />
            </Field>
            <Field label="Origin CA key" optional description="Only needed if your token cannot create origin certificates.">
              <Input type="password" value={originKey} onChange={(e) => setOriginKey(e.target.value)} className="font-mono" autoComplete="off" />
            </Field>
          </DialogBody>
          <DialogFooter>
            <DialogClose render={<Button variant="ghost" size="sm" />}>Cancel</DialogClose>
            <Button type="submit" variant="primary" size="sm" loading={pending}>
              Connect
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** The whole page, so "Connect account" can sit in the page header next to the title. */
export function CloudflareAccounts({ accounts, isAdmin, title, description }: { accounts: Account[]; isAdmin: boolean; title: string; description: string }) {
  const [open, setOpen] = React.useState(false);
  const confirm = useConfirm();
  const remove = useAction(disconnectCloudflare, { success: "Account disconnected" });
  return (
    <>
      <PageHeader
        title={title}
        description={description}
        actions={
          isAdmin &&
          accounts.length > 0 && (
            <Button variant="primary" size="sm" onClick={() => setOpen(true)}>
              <Plus /> Connect account
            </Button>
          )
        }
      />
      <PageBody className="flex flex-col gap-6">
      {accounts.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Cloud />}
            title="Connect your Cloudflare account"
            description="Create DNS records automatically when you add domains, issue wildcard and origin certificates, and change SSL settings from here."
            action={isAdmin && <Button variant="primary" size="sm" onClick={() => setOpen(true)}><Plus /> Connect Cloudflare</Button>}
          />
        </Card>
      ) : (
        <>
          {accounts.map((a) => (
            <Card key={a.id} className="overflow-hidden">
              <CardHeader
                title={
                  <span className="flex items-center gap-2">
                    <Cloud className="size-4 text-[#f38020]" /> {a.name}
                  </span>
                }
                description={a.error ? `Could not load zones: ${a.error}` : `${a.zones.length} zone${a.zones.length === 1 ? "" : "s"}`}
                actions={
                  isAdmin && (
                    <Button
                      variant="danger-ghost"
                      size="sm"
                      onClick={async () => {
                        if (await confirm({ title: `Disconnect ${a.name}?`, description: "Existing DNS records stay in Cloudflare. Certificates using this account stop renewing.", confirmLabel: "Disconnect", danger: true })) remove.run(a.id);
                      }}
                    >
                      <Trash2 /> Disconnect
                    </Button>
                  )
                }
              />
              <div className="divide-y divide-line">
                {a.zones.map((z) => (
                  <Link key={z.id} href={`/integrations/cloudflare/${a.id}/${z.id}`} className="flex items-center gap-3 px-5 py-3 transition-colors hover:bg-hover/40">
                    <span className="flex-1 text-[14px] font-medium text-fg">{z.name}</span>
                    {z.plan && <span className="text-xs text-muted">{z.plan}</span>}
                    <Badge tone={z.status === "active" ? "ok" : "warn"}>{z.status}</Badge>
                    <ChevronRight className="size-4 text-faint" />
                  </Link>
                ))}
              </div>
            </Card>
          ))}
        </>
      )}
      <ConnectCloudflareDialog open={open} onOpenChange={setOpen} />
      </PageBody>
    </>
  );
}
