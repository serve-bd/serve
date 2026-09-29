"use client";

import * as React from "react";
import { toast } from "@/components/ui/toast";
import Link from "next/link";
import { useRouter } from "@/hooks/use-router";
import { ChevronRight, Cloud, Plus, Server as ServerIcon, Trash2, Waypoints } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardHeader, EmptyState } from "@/components/ui/misc";
import { Dialog, DialogBody, DialogClose, DialogContent, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { useConfirm } from "@/components/ui/confirm";
import { useAction } from "@/hooks/use-action";
import { cloudflareDisconnectImpact, connectCloudflare, disableTunnel, disconnectCloudflare, enableTunnel, refreshTunnels, tunnelImpact } from "@/server/actions/integrations";
import { PageBody, PageHeader } from "@/components/shell/page-header";

type Account = { id: string; name: string; zones: { id: string; name: string; status: string; plan: string | null }[]; error: string | null };
type ServerOption = { id: string; name: string; isLocal: boolean; status: string };
type Tunnel = { id: string; accountId: string; serverId: string; status: string; statusMessage: string | null; domains: number };

const tunnelTone: Record<string, { color: string; label: string }> = {
  healthy: { color: "var(--ok)", label: "Connected" },
  degraded: { color: "var(--warn)", label: "Degraded" },
  down: { color: "var(--bad)", label: "Down" },
  error: { color: "var(--bad)", label: "Error" },
  pending: { color: "var(--warn)", label: "Connecting…" },
};

/** Tunnels from each server to this account: turn on, see status, remove. */
function TunnelsSection({ account, servers, tunnels, isAdmin }: { account: Account; servers: ServerOption[]; tunnels: Tunnel[]; isAdmin: boolean }) {
  const confirm = useConfirm();
  const router = useRouter();
  const [busy, setBusy] = React.useState<string | null>(null);
  const starting = tunnels.some((t) => t.accountId === account.id && (t.status === "pending" || t.status === "down"));
  // While a connector is coming up, ask Cloudflare every few seconds instead of waiting for the worker.
  React.useEffect(() => {
    if (!starting) return;
    const started = Date.now();
    const timer = setInterval(async () => {
      if (Date.now() - started > 3 * 60_000) return clearInterval(timer);
      await refreshTunnels();
      router.refresh();
    }, 4000);
    return () => clearInterval(timer);
  }, [starting, router]);
  const enable = useAction(enableTunnel, {
    onSuccess: (r) => {
      const n = r.reconnected.length;
      if (r.failed.length)
        toast.warning(
          n ? `Tunnel created. ${n} domain${n === 1 ? "" : "s"} reconnected` : "Tunnel created",
          `Could not reconnect ${r.failed.map((f) => f.hostname).join(", ")}. See Domains & ports for the reason.`,
        );
      else toast.success(n ? `Tunnel created. ${n} domain${n === 1 ? "" : "s"} reconnected to the tunnel.` : "Tunnel created. It connects within a minute.");
    },
  });
  const disable = useAction(disableTunnel, { success: "Tunnel removed" });
  return (
    <div className="border-t border-line">
      <div className="flex flex-wrap items-center justify-between gap-2 px-5 pt-4 pb-2">
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-[13px] font-medium text-fg">
            <Waypoints className="size-3.5 text-[#f38020]" /> Tunnels
          </p>
          <p className="text-xs text-muted">Serve domains from a server without a public IP or open ports. HTTPS is handled by Cloudflare.</p>
        </div>
      </div>
      <div className="divide-y divide-line">
        {servers.map((server) => {
          const tunnel = tunnels.find((t) => t.serverId === server.id && t.accountId === account.id);
          const tone = tunnel ? (tunnelTone[tunnel.status] ?? tunnelTone.pending) : null;
          return (
            <div key={server.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-5 py-3">
              <span className="flex min-w-0 flex-1 items-center gap-2 text-[13px]">
                <ServerIcon className="size-3.5 flex-none text-muted" />
                <span className="truncate font-medium text-fg">{server.name}</span>
                {server.isLocal && <span className="text-xs text-faint">this server</span>}
              </span>
              {tunnel && tone && (
                <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted">
                  <span className="size-1.5 flex-none rounded-full" style={{ background: tone.color }} />
                  <span className="text-fg-2">{tone.label}</span>
                  {tunnel.statusMessage && <span className="hidden truncate sm:inline">· {tunnel.statusMessage}</span>}
                  {tunnel.domains > 0 && (
                    <span>
                      · {tunnel.domains} domain{tunnel.domains === 1 ? "" : "s"}
                    </span>
                  )}
                </span>
              )}
              {isAdmin &&
                (tunnel ? (
                  <Button
                    size="xs"
                    variant="ghost"
                    loading={busy === server.id && disable.pending}
                    onClick={async () => {
                      const impact = await tunnelImpact(tunnel.id);
                      const offline = impact.ok ? impact.data : [];
                      if (
                        !(await confirm({
                          title: `Remove the tunnel from ${server.name}?`,
                          description: offline.length
                            ? "The connector stops and the tunnel is deleted in Cloudflare. These domains stop working until a tunnel runs on this server again; Serve then reconnects them automatically."
                            : "The connector stops and the tunnel is deleted in Cloudflare.",
                          confirmLabel: offline.length ? "Remove tunnel anyway" : "Remove tunnel",
                          danger: true,
                          children: offline.length ? (
                            <ul className="flex flex-col gap-0.5 rounded-xl border border-bad/25 bg-bad-soft px-3.5 py-3 font-mono text-[12.5px] text-fg-2">
                              {offline.map((h) => (
                                <li key={h}>{h}</li>
                              ))}
                            </ul>
                          ) : undefined,
                        }))
                      )
                        return;
                      setBusy(server.id);
                      await disable.run(tunnel.id);
                    }}
                  >
                    Remove
                  </Button>
                ) : (
                  <Button
                    size="xs"
                    disabled={!server.isLocal && server.status !== "ready"}
                    loading={busy === server.id && enable.pending}
                    onClick={async () => {
                      setBusy(server.id);
                      await enable.run(account.id, server.id);
                    }}
                  >
                    Create tunnel
                  </Button>
                ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

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
                  Create one at <span className="text-fg-2">dash.cloudflare.com → My Profile → API Tokens</span> with Zone · Read, DNS · Edit, Zone Settings · Edit and SSL and
                  Certificates · Edit. Add Account · Cloudflare Tunnel · Edit to use tunnels.
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
export function CloudflareAccounts({
  accounts,
  isAdmin,
  title,
  description,
  servers,
  tunnels,
}: {
  accounts: Account[];
  isAdmin: boolean;
  title: string;
  description: string;
  servers: ServerOption[];
  tunnels: Tunnel[];
}) {
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
              action={
                isAdmin && (
                  <Button variant="primary" size="sm" onClick={() => setOpen(true)}>
                    <Plus /> Connect Cloudflare
                  </Button>
                )
              }
            />
          </Card>
        ) : (
          accounts.map((a) => (
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
                        const impact = await cloudflareDisconnectImpact(a.id);
                        const tunnels = impact.ok ? impact.data : [];
                        const offline = tunnels.flatMap((t) => t.domains);
                        const ok = await confirm({
                          title: `Disconnect ${a.name}?`,
                          description: tunnels.length
                            ? `This stops and deletes ${tunnels.length === 1 ? "the Cloudflare Tunnel" : `${tunnels.length} Cloudflare Tunnels`} of this account. Other DNS records stay in Cloudflare, and certificates using this account stop renewing.`
                            : "Existing DNS records stay in Cloudflare. Certificates using this account stop renewing.",
                          confirmLabel: tunnels.length ? "Disconnect and stop tunnels" : "Disconnect",
                          danger: true,
                          typeToConfirm: offline.length ? a.name : undefined,
                          children:
                            tunnels.length > 0 ? (
                              <div className="flex flex-col gap-2 rounded-xl border border-bad/25 bg-bad-soft px-3.5 py-3 text-[13px]">
                                <p className="font-medium text-fg">
                                  {offline.length ? `${offline.length} site${offline.length === 1 ? "" : "s"} will stop working:` : "No domains use these tunnels."}
                                </p>
                                {offline.length > 0 && (
                                  <ul className="flex flex-col gap-0.5 font-mono text-[12.5px] text-fg-2">
                                    {offline.map((h) => (
                                      <li key={h}>{h}</li>
                                    ))}
                                  </ul>
                                )}
                                <p className="text-xs text-muted">{tunnels.map((t) => `${t.name} on ${t.serverName}`).join(", ")}</p>
                              </div>
                            ) : undefined,
                        });
                        if (ok) remove.run(a.id);
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
              {!a.error && <TunnelsSection account={a} servers={servers} tunnels={tunnels} isAdmin={isAdmin} />}
            </Card>
          ))
        )}
        <ConnectCloudflareDialog open={open} onOpenChange={setOpen} />
      </PageBody>
    </>
  );
}
