"use client";

import * as React from "react";
import { toast } from "@/components/ui/toast";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { ChevronRight, Cloud, KeyRound, Plus, RefreshCw, Server as ServerIcon, Trash2, Waypoints } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, EmptyState } from "@/components/ui/misc";
import { Dialog, DialogBody, DialogClose, DialogContent, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { useConfirm } from "@/components/ui/confirm";
import { showError, useAction } from "@/hooks/use-action";
import { cloudflareDisconnectImpact, connectCloudflare, disconnectCloudflare, enableTunnel, refreshTunnels, startCloudflareOauth } from "@/server/actions/integrations";
import { TunnelRow, type TunnelInfo } from "./tunnel-row";
import { MethodOption } from "../git/oauth-apps";
import { PageBody, PageHeader } from "@/components/shell/page-header";

type Account = {
  id: string;
  name: string;
  cfAccountId: string | null;
  oauth: boolean;
  zones: { id: string; name: string; status: string; plan: string | null }[];
  error: string | null;
};
type ServerOption = { id: string; name: string; isLocal: boolean; status: string };
type Tunnel = TunnelInfo;

/** Tunnels from each server to this account: turn on, see status and details, remove. */
function TunnelsSection({ account, servers, tunnels, isAdmin }: { account: Account; servers: ServerOption[]; tunnels: Tunnel[]; isAdmin: boolean }) {
  // Servers whose "Create tunnel" is running. Clicks on several servers queue up; each keeps its spinner.
  const [busy, setBusy] = React.useState<ReadonlySet<string>>(new Set());
  // Tunnels just created here, shown until the refreshed page brings them.
  const [created, setCreated] = React.useState<Tunnel[]>([]);
  const known = tunnels.map((t) => t.id).join();
  // Once the page has them, the page is the source: a later removal must not bring them back.
  React.useEffect(() => {
    const ids = new Set(known.split(","));
    setCreated((c) => (c.some((t) => ids.has(t.id)) ? c.filter((t) => !ids.has(t.id)) : c));
  }, [known]);
  const mine = [...tunnels, ...created.filter((c) => !tunnels.some((t) => t.id === c.id))].filter((t) => t.accountId === account.id);
  const withTunnel = mine.map((t) => t.serverId).join();
  // Forget servers whose tunnel now shows, so a later "Create tunnel" there starts without a spinner.
  React.useEffect(() => {
    const has = new Set(withTunnel.split(","));
    setBusy((b) => ([...b].some((id) => has.has(id)) ? new Set([...b].filter((id) => !has.has(id))) : b));
  }, [withTunnel]);
  const starting = mine.some((t) => t.status === "pending" || t.status === "down");
  // While a connector is coming up, ask Cloudflare every few seconds instead of waiting for the worker's check.
  React.useEffect(() => {
    if (!starting) return;
    const started = Date.now();
    let busy = false;
    const timer = setInterval(async () => {
      if (Date.now() - started > 3 * 60_000) return clearInterval(timer);
      // One check at a time, even when Cloudflare answers slowly.
      if (busy) return;
      busy = true;
      // A status change reaches the page as a live event, which refreshes it.
      await refreshTunnels().catch(() => {});
      busy = false;
    }, 4000);
    return () => clearInterval(timer);
  }, [starting]);
  const enable = useAction(enableTunnel, {
    onSuccess: (r) => {
      setCreated((c) => [...c.filter((t) => t.id !== r.tunnel.id), r.tunnel]);
      const n = r.reconnected.length;
      if (r.failed.length)
        toast.warning(
          n ? `Tunnel created. ${n} domain${n === 1 ? "" : "s"} reconnected` : "Tunnel created",
          `Could not reconnect ${r.failed.map((f) => f.hostname).join(", ")}. See Domains & ports for the reason.`,
        );
      else toast.success(n ? `Tunnel created. ${n} domain${n === 1 ? "" : "s"} reconnected to the tunnel.` : "Tunnel created. It connects within a minute.");
    },
  });
  return (
    <Card className="overflow-hidden">
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            <Waypoints className="size-4 text-[#f38020]" /> Tunnels
          </span>
        }
        description={`Serve domains of ${account.name} from a server without a public IP or open ports. HTTPS is handled by Cloudflare.`}
      />
      <div className="divide-y divide-line">
        {servers.map((server) => {
          const tunnel = mine.find((t) => t.serverId === server.id);
          if (tunnel) {
            return <TunnelRow key={server.id} tunnel={tunnel} server={server} cfAccountId={account.cfAccountId} isAdmin={isAdmin} defaultOpen={mine.length === 1} />;
          }
          const notReady = !server.isLocal && server.status !== "ready";
          return (
            <div key={server.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-5 py-3">
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="flex min-w-0 items-center gap-2 text-[13px]">
                  <ServerIcon className="size-3.5 flex-none text-muted" />
                  <span className="truncate font-medium text-fg">{server.name}</span>
                  {server.isLocal && <span className="flex-none text-xs text-faint">this server</span>}
                </span>
                <span className="pl-5.5 text-xs text-muted">{notReady ? "Validate this server before creating a tunnel." : "No tunnel"}</span>
              </span>
              {isAdmin && (
                <Button
                  size="xs"
                  disabled={notReady}
                  loading={busy.has(server.id)}
                  onClick={async () => {
                    if (busy.has(server.id)) return;
                    setBusy((b) => new Set(b).add(server.id));
                    // On success the spinner stays until the refreshed page shows the tunnel.
                    if (!(await enable.run(account.id, server.id)))
                      setBusy((b) => {
                        const next = new Set(b);
                        next.delete(server.id);
                        return next;
                      });
                  }}
                >
                  Create tunnel
                </Button>
              )}
            </div>
          );
        })}
      </div>
    </Card>
  );
}

/** Opens Cloudflare's sign-in. With an account, it renews that account's access. */
function useCloudflareSignIn() {
  return useAction(startCloudflareOauth, {
    refresh: false,
    onSuccess: (url) => {
      window.location.href = url;
    },
  });
}

export function ConnectCloudflareDialog({ open, onOpenChange, oauth }: { open: boolean; onOpenChange: (o: boolean) => void; oauth: boolean }) {
  const signIn = useCloudflareSignIn();
  // Without sign-in on this instance, the token form is the only way, so it shows at once.
  const [method, setMethod] = React.useState<"choose" | "token">(oauth ? "choose" : "token");
  const [name, setName] = React.useState("");
  const [token, setToken] = React.useState("");
  const [originKey, setOriginKey] = React.useState("");
  const { run, pending } = useAction(() => connectCloudflare({ name, apiToken: token, originCaKey: originKey }), {
    onSuccess: () => {
      onOpenChange(false);
      setToken("");
    },
  });
  // Each opening starts at the choice again.
  React.useEffect(() => {
    if (open) setMethod(oauth ? "choose" : "token");
  }, [open, oauth]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        {method === "choose" ? (
          <>
            <DialogHeader title="Connect Cloudflare" description="Manage DNS, certificates and tunnels of your domains from Serve." />
            <DialogBody>
              <MethodOption
                icon={<Cloud />}
                title="Sign in with Cloudflare"
                badge="Recommended"
                body="Log in to Cloudflare and allow access. Nothing to copy."
                disabled={signIn.pending}
                onClick={() => signIn.run()}
              />
              <MethodOption
                icon={<KeyRound />}
                title="Paste an API token"
                body="Create a token in Cloudflare yourself. Needed for Traefik's Cloudflare certificates."
                onClick={() => setMethod("token")}
              />
            </DialogBody>
          </>
        ) : (
          <form
            method="post"
            onSubmit={(e) => {
              e.preventDefault();
              void run();
            }}
          >
            <DialogHeader title="Paste an API token" description="Tokens are encrypted and only used for your zones." />
            <DialogBody>
              <Field
                label="API token"
                description={
                  <>
                    Create one at <span className="text-fg-2">dash.cloudflare.com → My Profile → API Tokens → Create Token → Custom token</span>, with these permissions:
                  </>
                }
              >
                <Input type="password" value={token} onChange={(e) => setToken(e.target.value)} required className="font-mono" autoComplete="off" autoFocus />
              </Field>
              <TokenPermissions />
              <Field label="Name" optional>
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Company account" />
              </Field>
              <Field label="Origin CA key" optional description="Only needed if your token cannot create origin certificates.">
                <Input type="password" value={originKey} onChange={(e) => setOriginKey(e.target.value)} className="font-mono" autoComplete="off" />
              </Field>
            </DialogBody>
            <DialogFooter>
              {oauth ? (
                <Button type="button" variant="ghost" size="sm" onClick={() => setMethod("choose")}>
                  Back
                </Button>
              ) : (
                <DialogClose render={<Button variant="ghost" size="sm" />}>Cancel</DialogClose>
              )}
              <Button type="submit" variant="primary" size="sm" loading={pending}>
                Connect
              </Button>
            </DialogFooter>
          </form>
        )}
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
  oauth,
}: {
  accounts: Account[];
  isAdmin: boolean;
  title: string;
  description: React.ReactNode;
  servers: ServerOption[];
  tunnels: Tunnel[];
  oauth: boolean;
}) {
  const [open, setOpen] = React.useState(false);
  const signIn = useCloudflareSignIn();
  const router = useRouter();
  const params = useSearchParams();
  const announced = React.useRef(false);
  // Back from Cloudflare's sign-in: the account in the list shows a success, so only errors get a message.
  React.useEffect(() => {
    const error = params.get("error");
    if ((!error && !params.get("connected")) || announced.current) return;
    announced.current = true;
    if (error) showError("Cloudflare did not connect", error);
    router.replace("/integrations/cloudflare");
  }, [params, router]);
  const confirm = useConfirm();
  const remove = useAction(disconnectCloudflare);
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
            <div key={a.id} className="flex flex-col gap-3">
              <Card className="overflow-hidden">
                <CardHeader
                  title={
                    <span className="flex items-center gap-2">
                      <Cloud className="size-4 text-[#f38020]" /> {a.name}
                    </span>
                  }
                  description={a.error ? `Could not load zones: ${a.error}` : `${a.zones.length} zone${a.zones.length === 1 ? "" : "s"}`}
                  actions={
                    isAdmin && (
                      <div className="flex items-center gap-1">
                        {a.oauth && a.error && oauth && (
                          <Button variant="secondary" size="sm" loading={signIn.pending} onClick={() => signIn.run(a.id)}>
                            <RefreshCw /> Reconnect
                          </Button>
                        )}
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
                      </div>
                    )
                  }
                />
                <div className="divide-y divide-line">
                  {a.zones.map((z) => (
                    <Link key={z.id} href={`/integrations/cloudflare/${a.id}/${z.id}`} className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-hover/40 sm:px-5">
                      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span className="truncate text-[14px] font-medium text-fg">{z.name}</span>
                        {(z.plan || z.status !== "active") && (
                          <span className="truncate text-xs text-muted">
                            {/* Active is the normal state; only other states are worth a word. */}
                            {z.status !== "active" && <span className="text-warn capitalize">{z.status}</span>}
                            {z.status !== "active" && z.plan && " · "}
                            {z.plan}
                          </span>
                        )}
                      </span>
                      <ChevronRight className="size-4 flex-none text-faint" />
                    </Link>
                  ))}
                </div>
              </Card>
              {!a.error && <TunnelsSection account={a} servers={servers} tunnels={tunnels} isAdmin={isAdmin} />}
            </div>
          ))
        )}
        <ConnectCloudflareDialog open={open} onOpenChange={setOpen} oauth={oauth} />
      </PageBody>
    </>
  );
}

/** The token permissions, in the same three columns as Cloudflare's token form. */
const PERMISSIONS: [string, string, string, string?][] = [
  ["Zone", "Zone", "Read"],
  ["Zone", "DNS", "Edit"],
  ["Zone", "Zone Settings", "Edit"],
  ["Zone", "SSL and Certificates", "Edit"],
  ["Account", "Cloudflare Tunnel", "Edit", "Only to use tunnels"],
];

function TokenPermissions() {
  return (
    <div className="-mt-2 overflow-hidden rounded-xl border border-line text-[12.5px]">
      <div className="grid grid-cols-[5rem_1fr_4rem] gap-3 border-b border-line bg-surface-2 px-3 py-1.5 text-[11px] font-medium tracking-wide text-faint uppercase">
        <span>Type</span>
        <span>Permission</span>
        <span>Access</span>
      </div>
      {PERMISSIONS.map(([type, permission, access, note]) => (
        <div key={permission} className="grid grid-cols-[5rem_1fr_4rem] items-baseline gap-3 border-b border-line px-3 py-1.5 last:border-b-0">
          <span className="text-muted">{type}</span>
          <span className="text-fg">
            {permission}
            {note && <span className="ml-1.5 text-[11.5px] text-faint">{note}</span>}
          </span>
          <span className="text-fg-2">{access}</span>
        </div>
      ))}
    </div>
  );
}
