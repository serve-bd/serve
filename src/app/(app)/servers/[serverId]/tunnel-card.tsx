"use client";

import * as React from "react";
import { AlertTriangle, Cable, KeyRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader, TimeAgo } from "@/components/ui/misc";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/toast";
import { JoinCommand } from "@/components/tunnel-join";
import { newJoinCommand } from "@/server/actions/tunnel";
import { cn } from "@/lib/utils";
import { useRouter } from "@/hooks/use-router";

export type TunnelView = {
  connectedAt: string | null;
  remote: string | null;
  joined: boolean;
  address: string;
  port: number;
  /** The worker's listener: not running (with why), or null when fine. */
  listenerError: string | null;
};

/** A server without a public IP: whether its tunnel is up, and a new join command when needed. */
export function TunnelCard({ serverId, user, sshPort, tunnel }: { serverId: string; user: string; sshPort: number; tunnel: TunnelView }) {
  const router = useRouter();
  const [address, setAddress] = React.useState(tunnel.address);
  const [command, setCommand] = React.useState<{ command: string; expiresAt: string } | null>(null);
  const [busy, setBusy] = React.useState(false);
  const connected = !!tunnel.connectedAt;

  const create = async () => {
    setBusy(true);
    const res = await newJoinCommand(serverId, window.location.origin, address);
    setBusy(false);
    if (!res.ok) return toast.error(res.error);
    setCommand(res.data);
    // "Connects to" shows the address the new command uses.
    router.refresh();
  };

  return (
    <Card>
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            <Cable className="size-4 text-muted" /> Tunnel
          </span>
        }
        description="This server has no public IP. It keeps an encrypted SSH tunnel open to this dashboard, which reaches it through that tunnel."
      />
      <CardBody className="flex flex-col gap-4 py-5">
        {tunnel.listenerError && (
          <p className="flex items-start gap-2 rounded-xl border border-bad/25 bg-bad-soft px-3.5 py-3 text-[13px] leading-relaxed text-bad">
            <AlertTriangle className="mt-0.5 size-4 flex-none" />
            <span>Servers cannot connect: {tunnel.listenerError}</span>
          </p>
        )}
        <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-3">
          <div className="flex min-w-0 flex-col gap-1">
            <dt className="text-[11px] font-medium tracking-wide text-faint uppercase">Status</dt>
            <dd className="flex items-center gap-2 text-[13px] text-fg">
              <span className={cn("size-2 rounded-full", connected ? "bg-ok" : tunnel.joined ? "bg-bad" : "animate-led bg-warn")} />
              {connected ? (
                <span>
                  Connected <TimeAgo date={tunnel.connectedAt} className="text-muted" />
                </span>
              ) : tunnel.joined ? (
                "Not connected"
              ) : (
                "Waiting for the join command"
              )}
            </dd>
          </div>
          <div className="flex min-w-0 flex-col gap-1">
            <dt className="text-[11px] font-medium tracking-wide text-faint uppercase">Connects to</dt>
            <dd className="truncate font-mono text-[13px] text-fg">{`${tunnel.address}:${tunnel.port}`}</dd>
          </div>
          <div className="flex min-w-0 flex-col gap-1">
            <dt className="text-[11px] font-medium tracking-wide text-faint uppercase">Signs in as</dt>
            <dd className="truncate font-mono text-[13px] text-fg">{`${user} · port ${sshPort}`}</dd>
          </div>
        </dl>
        {!connected && tunnel.joined && (
          <p className="text-[13px] leading-relaxed text-muted">
            The server is off, has no internet, or its tunnel stopped. On the server, check <span className="font-mono text-fg-2">systemctl status serve-tunnel</span>. If it was
            reinstalled, run a new join command.
          </p>
        )}
        {command ? (
          <div className="flex flex-col gap-3">
            <JoinCommand command={command.command} expiresAt={command.expiresAt} user={user} address={address} port={tunnel.port} />
            <Button size="sm" variant="ghost" className="self-start" onClick={() => setCommand(null)}>
              Change the address or make another command
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-3 border-t border-line pt-4 sm:flex-row sm:items-end">
            <Field label="Dashboard address the server connects to" className="min-w-0 flex-1">
              <Input value={address} onChange={(e) => setAddress(e.target.value.trim())} className="font-mono" autoComplete="off" spellCheck={false} />
            </Field>
            <Button onClick={() => void create()} loading={busy} disabled={!address}>
              <KeyRound /> New join command
            </Button>
          </div>
        )}
      </CardBody>
    </Card>
  );
}
