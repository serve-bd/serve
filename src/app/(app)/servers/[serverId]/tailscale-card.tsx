"use client";

import * as React from "react";
import Link from "next/link";
import { AlertTriangle, KeyRound, Network, Unplug } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader, TimeAgo } from "@/components/ui/misc";
import { Checkbox } from "@/components/ui/checkbox";
import { Field } from "@/components/ui/field";
import { Select } from "@/components/ui/select";
import { useConfirm } from "@/components/ui/confirm";
import { TailscaleJoinCommand } from "@/components/tailscale-join";
import { useAction } from "@/hooks/use-action";
import { connectThroughTailscale, stopUsingTailscale, tailscaleJoinCommand } from "@/server/actions/tailscale";
import type { TailscaleView } from "@/server/tailscale/view";
import { cn } from "@/lib/utils";

type Props = {
  server: { id: string; name: string; isLocal: boolean; ready: boolean; user: string };
  view: TailscaleView | null;
  tailnets: { id: string; name: string }[];
};

function Item({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <dt className="text-[11px] font-medium tracking-wide text-faint uppercase">{label}</dt>
      <dd className="min-w-0 truncate text-[13px] text-fg">{children}</dd>
    </div>
  );
}

/** Asks whether to also take the device out of the tailnet; the answer is read when the dialog closes. */
function RemoveDeviceChoice({ onChange }: { onChange: (v: boolean) => void }) {
  const [on, setOn] = React.useState(false);
  return (
    <label className="mt-3 flex cursor-pointer items-center gap-2.5 text-[13px] text-fg">
      <Checkbox
        checked={on}
        onCheckedChange={(v) => {
          setOn(!!v);
          onChange(!!v);
        }}
      />
      Also remove its device from the tailnet
    </label>
  );
}

/** A server in (or joining) a tailnet: its address, whether Tailscale sees it online, and whether the dashboard reaches it. */
export function TailscaleCard({ server, view, tailnets }: Props) {
  const confirm = useConfirm();
  const [tailnetId, setTailnetId] = React.useState<string | null>(view?.tailnetId ?? tailnets[0]?.id ?? null);
  const [command, setCommand] = React.useState<{ command: string; expiresAt: string } | null>(null);
  const tailnetName = tailnets.find((t) => t.id === tailnetId)?.name ?? view?.tailnetName ?? "the tailnet";
  const connect = useAction((force: boolean) => connectThroughTailscale(server.id, tailnetId ?? "", force), {
    onSuccess: async (data) => {
      if (!data.moveNeeded) return;
      if (
        await confirm({
          title: `Move ${server.name} to ${tailnetName}?`,
          description: `${data.message ?? "This machine is in another tailnet."} Moving it takes it out of that tailnet.`,
          confirmLabel: "Move it",
          danger: true,
        })
      )
        await connect.run(true);
    },
  });
  const join = useAction(() => tailscaleJoinCommand(server.id, tailnetId ?? "", window.location.origin), { onSuccess: setCommand });
  const stop = useAction((removeDevice: boolean) => stopUsingTailscale(server.id, removeDevice));

  // A device removed from the tailnet (its error says so) is not joined any more, even with an old address kept.
  const left = !!view?.error && !!view.tailnetId;
  const joined = !!view?.address && !!view.tailnetId && !left;
  const lost = !!view && !view.tailnetId;
  const picker = tailnets.length > 1 && !joined && (
    <Field label="Tailnet" className="sm:max-w-xs">
      <Select value={tailnetId} onValueChange={setTailnetId} options={tailnets.map((t) => ({ value: t.id, label: t.name }))} />
    </Field>
  );
  const commandBlock = command && <TailscaleJoinCommand command={command.command} expiresAt={command.expiresAt} user={server.user} tailnet={tailnetName} />;

  return (
    <Card>
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            <Network className="size-4 text-muted" /> Tailscale
          </span>
        }
        description={
          server.isLocal
            ? "The dashboard's machine in the tailnet: Serve's containers reach the servers' Tailscale addresses through it."
            : joined
              ? "Serve reaches this server at its Tailscale address, over SSH as before."
              : "Reach this server through your tailnet instead of its public address or tunnel."
        }
      />
      <CardBody className="flex flex-col gap-4 py-5">
        {view?.error && (
          <p className="flex items-start gap-2 rounded-xl border border-bad/25 bg-bad-soft px-3.5 py-3 text-[13px] leading-relaxed break-words text-bad">
            <AlertTriangle className="mt-0.5 size-4 flex-none" />
            <span>{view.error}</span>
          </p>
        )}
        {lost && (
          <p className="flex items-start gap-2 rounded-xl border border-bad/25 bg-bad-soft px-3.5 py-3 text-[13px] leading-relaxed text-bad">
            <AlertTriangle className="mt-0.5 size-4 flex-none" />
            <span>
              The tailnet this server was in was disconnected from Serve.{" "}
              {tailnets.length ? (
                "Connect it through a tailnet again below."
              ) : (
                <Link href="/integrations/tailscale" className="font-medium underline underline-offset-2">
                  Connect Tailscale again in Integrations.
                </Link>
              )}
            </span>
          </p>
        )}
        {joined && view && (
          <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-3">
            <Item label="Status">
              <span className="flex items-center gap-2">
                <span className={cn("size-2 flex-none rounded-full", view.online ? "bg-ok" : view.online === false ? "bg-bad" : "bg-idle")} />
                {view.online ? "Online" : view.online === false ? "Offline" : "Unknown"}
                {view.lastSeen && !view.online && (
                  <span className="text-muted">
                    · seen <TimeAgo date={view.lastSeen} />
                  </span>
                )}
              </span>
            </Item>
            <Item label="Address">
              <span className="font-mono">{view.address}</span>
            </Item>
            <Item label="Name in the tailnet">
              <span className="font-mono" title={view.dnsName ?? undefined}>
                {view.dnsName ?? "Unknown"}
              </span>
            </Item>
            <Item label="Tailnet">{view.tailnetName}</Item>
            {view.reach && (
              <Item label="From the dashboard">
                <span className={view.reach.ok ? "text-ok" : "text-bad"}>{view.reach.ok ? "Reachable" : "Not reachable"}</span>
              </Item>
            )}
          </dl>
        )}
        {view?.reach && !view.reach.ok && view.reach.hint && <p className="text-[13px] leading-relaxed text-bad">{view.reach.hint}</p>}
        {view?.waiting && !joined && !command && (
          <p className="text-[13px] leading-relaxed text-muted">Waiting for the join command to run on the server. Lost it? Make a new one; the old one stops working.</p>
        )}
        {!joined && picker}
        {commandBlock}
        <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4">
          {!joined && (server.isLocal || server.ready) && (
            <Button variant="primary" size="sm" loading={connect.pending} disabled={!tailnetId} onClick={() => void connect.run(false)}>
              <Network /> {server.isLocal ? "Add this server to the tailnet" : "Connect through Tailscale"}
            </Button>
          )}
          {/* A server that answers needs no new command; one added through Tailscale that stops answering gets it back. */}
          {!server.isLocal && (!joined || (view?.only && !view.online && !view.reach?.ok)) && (
            <Button size="sm" variant={(!joined && !server.ready) || left ? "primary" : "secondary"} loading={join.pending} disabled={!tailnetId} onClick={() => void join.run()}>
              <KeyRound /> {joined ? "New join command (after a reinstall)" : left ? "Join again" : command || view?.waiting ? "New join command" : "Join command instead"}
            </Button>
          )}
          {view && !(view.only && !server.isLocal) && (
            <Button
              size="sm"
              variant="ghost"
              loading={stop.pending}
              onClick={async () => {
                let removeDevice = false;
                const ok = await confirm({
                  title: joined ? `Stop using Tailscale for ${server.name}?` : "Cancel joining the tailnet?",
                  description: joined
                    ? server.isLocal
                      ? "Serve forgets this machine's place in the tailnet. Servers reached through Tailscale become unreachable until it is back."
                      : "Serve reaches the server as before: at its address, or through its tunnel. Tailscale keeps running on the machine."
                    : "The join command stops working.",
                  confirmLabel: joined ? "Stop using Tailscale" : "Cancel joining",
                  danger: joined,
                  children: joined && view.hasDevice ? <RemoveDeviceChoice onChange={(v) => (removeDevice = v)} /> : undefined,
                });
                if (ok) await stop.run(removeDevice);
              }}
            >
              <Unplug /> {joined ? "Stop using Tailscale" : "Cancel"}
            </Button>
          )}
        </div>
        {!joined && !server.isLocal && (
          <p className="text-xs leading-relaxed text-muted">
            {left
              ? "Run the join command on the machine (log in to it another way, like SSH at its public address or your provider's console). It joins the tailnet again and Serve reconnects by itself."
              : server.ready
                ? "Connect through Tailscale installs Tailscale on the server over SSH and joins it with a single-use key. The join command does the same when you run it on the machine."
                : "The server is not reachable right now: run the join command on the machine."}{" "}
            The dashboard&apos;s machine must be in the tailnet too (Integrations, Tailscale).
          </p>
        )}
        {view?.only && joined && !server.isLocal && <p className="text-xs leading-relaxed text-muted">Added through Tailscale: Serve has no other address for this server.</p>}
        {!view && tailnets.length === 0 && (
          <p className="text-xs text-muted">
            <Link href="/integrations/tailscale" className="text-accent hover:underline">
              Connect a tailnet
            </Link>{" "}
            first.
          </p>
        )}
      </CardBody>
    </Card>
  );
}
