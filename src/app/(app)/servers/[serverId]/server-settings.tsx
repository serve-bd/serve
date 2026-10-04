"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "@/hooks/use-router";
import { Fingerprint, PlugZap, RotateCcw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader, Copyable, TimeAgo } from "@/components/ui/misc";
import { Field } from "@/components/ui/field";
import { Input, InputGroup } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { SwitchRow } from "@/components/ui/switch";
import { StatusLabel } from "@/components/ui/status";
import { useConfirm } from "@/components/ui/confirm";
import { useAction } from "@/hooks/use-action";
import { deleteServer, resetHostKey, updateServer, validateServer } from "@/server/actions/servers";
import type { ServerStatus } from "@/server/db/schema";
import { SettingsCard } from "@/app/(app)/settings/_components/settings-card";
import { ServerSetupProgress } from "../new/add-server";

export type ServerDetails = {
  id: string;
  name: string;
  description: string | null;
  isLocal: boolean;
  host: string;
  port: number;
  username: string;
  privateKeyId: string | null;
  hostKey: string | null;
  hostKeyFingerprint: string | null;
  /** No public IP: it connects out through a tunnel. */
  tunnel: boolean;
  /** For such a server: its tunnel is up right now. */
  tunnelConnected: boolean;
  dataDir: string;
  status: ServerStatus;
  statusMessage: string | null;
  lastSeenAt: string | null;
  organizationIds: string[] | null;
  /** Organization that brought the server; null: the instance's. */
  ownerOrganizationId: string | null;
  services: number;
  /** Added through Tailscale: reached only at its Tailscale address, so its host is not edited here. */
  tailscaleOnly?: boolean;
  /** Its device in the tailnet (MagicDNS name), when it joined one through Serve. */
  tailnetDevice?: string | null;
};

export function ConnectionSettings({ server, keys }: { server: ServerDetails; keys: { id: string; name: string }[] }) {
  if (server.isLocal) {
    return (
      <SettingsCard
        title="Details"
        description={<>How this server appears in the dashboard.</>}
        initial={{ name: server.name, description: server.description ?? "" }}
        onSave={(v) => updateServer(server.id, { name: v.name, description: v.description || null })}
      >
        {(v, set) => (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Name">
              <Input value={v.name} onChange={(e) => set("name")(e.target.value)} />
            </Field>
            <Field label="Description" optional>
              <Input value={v.description} onChange={(e) => set("description")(e.target.value)} placeholder="Where this dashboard runs" />
            </Field>
          </div>
        )}
      </SettingsCard>
    );
  }
  return (
    <SettingsCard
      title="Connection"
      description="Changing the address, user or key validates the server again."
      initial={{
        name: server.name,
        description: server.description ?? "",
        host: server.host,
        port: String(server.port),
        username: server.username,
        privateKeyId: server.privateKeyId ?? "",
        dataDir: server.dataDir,
      }}
      onSave={(v) =>
        updateServer(server.id, {
          name: v.name,
          description: v.description || null,
          host: v.host,
          port: Number(v.port) || 22,
          username: v.username,
          privateKeyId: v.privateKeyId,
          dataDir: v.dataDir,
        })
      }
    >
      {(v, set) => (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Name">
              <Input value={v.name} onChange={(e) => set("name")(e.target.value)} />
            </Field>
            <Field label="Description" optional>
              <Input value={v.description} onChange={(e) => set("description")(e.target.value)} placeholder="Frankfurt, 8 vCPU" />
            </Field>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-[minmax(0,1fr)_110px]">
            {server.tailscaleOnly ? (
              <Field label="Name in the tailnet" description="Serve connects to its Tailscale address (see Tailscale below).">
                <Input value={v.host} disabled className="font-mono" />
              </Field>
            ) : (
              <Field label="IP address or hostname">
                <Input value={v.host} onChange={(e) => set("host")(e.target.value)} className="font-mono" spellCheck={false} />
              </Field>
            )}
            <Field label="SSH port">
              <Input value={v.port} onChange={(e) => set("port")(e.target.value.replace(/\D/g, "").slice(0, 5))} inputMode="numeric" className="font-mono" />
            </Field>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="User">
              <Input value={v.username} onChange={(e) => set("username")(e.target.value)} className="font-mono" spellCheck={false} />
            </Field>
            <Field
              label="SSH key"
              description={
                <>
                  Manage keys in{" "}
                  <Link href="/keys/ssh" className="text-accent hover:underline">
                    Keys &amp; tokens
                  </Link>
                  .
                </>
              }
            >
              <Select value={v.privateKeyId || null} onValueChange={set("privateKeyId")} options={keys.map((k) => ({ value: k.id, label: k.name }))} placeholder="Choose a key" />
            </Field>
          </div>
          <Field label="Data directory" description={<>Where repositories, proxy configuration and certificates are kept on this server.</>}>
            <Input value={v.dataDir} onChange={(e) => set("dataDir")(e.target.value)} className="font-mono sm:max-w-sm" spellCheck={false} />
          </Field>
        </>
      )}
    </SettingsCard>
  );
}

/** A server whose device left its tailnet: its join command, offered where the error shows. */
export type Rejoin = { tailnetId: string; tailnetName: string; user: string };

export function ValidationCard({ server, rejoin }: { server: ServerDetails; rejoin?: Rejoin }) {
  const router = useRouter();
  const confirm = useConfirm();
  const [watching, setWatching] = React.useState(server.status === "validating" || server.status !== "ready");
  const validate = useAction((installDocker: boolean) => validateServer(server.id, { installDocker }), { onSuccess: () => setWatching(true) });
  const reset = useAction(() => resetHostKey(server.id), { result: "Host key reset. Validate to pin the new key." });

  return (
    <Card>
      <CardHeader
        title="Status"
        description={
          server.lastSeenAt ? (
            <>
              Last reached <TimeAgo date={server.lastSeenAt} />.
            </>
          ) : (
            "Checks SSH, Docker and the proxy on this server."
          )
        }
        actions={
          <Button
            size="sm"
            onClick={() => void validate.run(false)}
            loading={validate.pending}
            // Without its tunnel a server that connects out cannot be reached: validating would only fail.
            disabled={server.status === "validating" || (server.tunnel && !server.tunnelConnected)}
            title={server.tunnel && !server.tunnelConnected ? "Waiting for the server's tunnel to connect" : undefined}
          >
            <PlugZap /> Validate connection
          </Button>
        }
      />
      <CardBody className="flex flex-col gap-4 py-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <StatusLabel status={server.status} kind="server" />
          {server.hostKeyFingerprint && (
            <span className="flex min-w-0 items-center gap-2 text-xs text-muted">
              <Fingerprint className="size-3.5 flex-none" />
              <code className="min-w-0 truncate font-mono text-[11.5px]">{server.hostKeyFingerprint}</code>
              <Button
                size="xs"
                variant="ghost"
                loading={reset.pending}
                onClick={async () => {
                  if (
                    await confirm({
                      title: "Reset the host key?",
                      description: "Only do this after reinstalling the server. The key the server presents on the next connection is trusted.",
                      confirmLabel: "Reset host key",
                      danger: true,
                    })
                  )
                    await reset.run();
                  router.refresh();
                }}
              >
                <RotateCcw /> Reset
              </Button>
            </span>
          )}
        </div>
        {watching ? (
          // A new status (the server connected, a setup started elsewhere) starts watching afresh.
          <ServerSetupProgress key={`${validate.pending ? "pending" : "watch"}|${server.status}`} serverId={server.id} compact rejoin={rejoin} />
        ) : (
          <button type="button" onClick={() => setWatching(true)} className="w-fit text-[12.5px] font-medium text-accent hover:underline">
            Show the last setup log
          </button>
        )}
      </CardBody>
    </Card>
  );
}

const count = (value: string, fallback = 1) => Number(value.replace(/\D/g, "").slice(0, 4)) || fallback;

/** How much this server builds at once, and how long it keeps images. */
export function BuildsCard({ serverId, limits }: { serverId: string; limits: { buildConcurrency: number; imageRetention: number } }) {
  return (
    <SettingsCard
      title="Builds"
      description="How many builds this server runs at once, and how many images it keeps for rollbacks."
      initial={{ builds: String(limits.buildConcurrency), images: String(limits.imageRetention) }}
      onSave={(v) => updateServer(serverId, { buildConcurrency: count(v.builds), imageRetention: count(v.images) })}
    >
      {(v, set) => (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Concurrent builds" description="More need more CPU and memory; the rest wait.">
            <Input value={v.builds} onChange={(e) => set("builds")(e.target.value.replace(/\D/g, ""))} inputMode="numeric" />
          </Field>
          <Field label="Images kept per service" description="Each kept image allows an instant rollback.">
            <Input value={v.images} onChange={(e) => set("images")(e.target.value.replace(/\D/g, ""))} inputMode="numeric" />
          </Field>
        </div>
      )}
    </SettingsCard>
  );
}

export function DeploymentsCard({ serverId, limits }: { serverId: string; limits: { deployTimeoutMinutes: number | null; deployQueueLimit: number | null } }) {
  return (
    <SettingsCard
      title="Deployments"
      description="Limits for deployments to this server. Empty fields have no limit of their own."
      initial={{
        timeout: limits.deployTimeoutMinutes ? String(limits.deployTimeoutMinutes) : "",
        queue: limits.deployQueueLimit ? String(limits.deployQueueLimit) : "",
      }}
      onSave={(v) => updateServer(serverId, { deployTimeoutMinutes: v.timeout ? Number(v.timeout) : null, deployQueueLimit: v.queue ? Number(v.queue) : null })}
    >
      {(v, set) => (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Time limit" optional description="Longer deployments are stopped; the previous version keeps running.">
            <InputGroup suffix="min">
              <Input value={v.timeout} onChange={(e) => set("timeout")(e.target.value.replace(/\D/g, ""))} placeholder="Default" inputMode="numeric" />
            </InputGroup>
          </Field>
          <Field label="Queue size" optional description="Deployments that may wait. A full queue refuses new ones; pushes show as skipped.">
            <Input value={v.queue} onChange={(e) => set("queue")(e.target.value.replace(/\D/g, ""))} placeholder="No limit" inputMode="numeric" />
          </Field>
        </div>
      )}
    </SettingsCard>
  );
}

/** How a remote server's metrics reach the dashboard. */
export type AgentStatus = { kind: "push" | "ssh"; seenAt: string; version: string | null } | { kind: "starting" } | { kind: "error"; message: string } | { kind: "none" };

function AgentLine({ status }: { status: AgentStatus }) {
  const dot = (tone: string) => <span className={`mt-1.5 size-1.5 flex-none rounded-full ${tone}`} />;
  return (
    <p className="flex items-start gap-2 text-xs leading-relaxed text-muted">
      {status.kind === "push" ? (
        <>
          {dot("bg-ok")}
          <span>
            The metrics agent{status.version ? ` v${status.version}` : ""} on this server sends samples to the dashboard. Last <TimeAgo date={status.seenAt} />.
          </span>
        </>
      ) : status.kind === "ssh" ? (
        <>
          {dot("bg-warn")}
          <span>
            The metrics agent cannot reach the dashboard from this server, so its samples are collected over SSH. Last <TimeAgo date={status.seenAt} />. Give the dashboard a domain
            this server can reach to have them sent directly.
          </span>
        </>
      ) : status.kind === "starting" ? (
        <>
          {dot("bg-info")}
          <span>Starting the metrics agent on this server…</span>
        </>
      ) : status.kind === "error" ? (
        <>
          {dot("bg-warn")}
          <span>The metrics agent could not start ({status.message}). Metrics are read over SSH until it does; it is tried again every few minutes.</span>
        </>
      ) : (
        <>
          {dot("bg-idle")}
          <span>Metrics are read over SSH.</span>
        </>
      )}
    </p>
  );
}

/** Whether this server records metrics, for how long, and (remote) how they arrive. */
export function MetricsCard({ serverId, enabled, hours, agent }: { serverId: string; enabled: boolean; hours: number; agent: AgentStatus | null }) {
  return (
    <SettingsCard
      title="Metrics"
      description="CPU, memory and disk of this server and its services, sampled every 30 seconds. Request counts of domains are separate and stay on."
      initial={{ enabled, hours: String(hours) }}
      onSave={(v) => updateServer(serverId, v.enabled ? { metricsEnabled: true, metricsRetentionHours: count(v.hours) } : { metricsEnabled: false })}
    >
      {(v, set) => (
        <>
          <SwitchRow
            title="Collect metrics"
            description={
              v.enabled
                ? "Charts show on the Metrics pages of this server and of the services on it. Resource alerts use them."
                : `Nothing is sampled${agent ? " and no agent runs on the server" : ""}. Metrics pages and charts are hidden, and resource alerts (CPU, memory, disk) stop.`
            }
            checked={v.enabled}
            onCheckedChange={set("enabled")}
          />
          {v.enabled && (
            <>
              <Field label="History" description="Samples older than this are removed. Charts over more than a day show 5-minute averages." className="sm:max-w-xs">
                <InputGroup suffix="hours">
                  <Input value={v.hours} onChange={(e) => set("hours")(e.target.value.replace(/\D/g, ""))} inputMode="numeric" />
                </InputGroup>
              </Field>
              {enabled && agent && <AgentLine status={agent} />}
            </>
          )}
        </>
      )}
    </SettingsCard>
  );
}

const INSTANCE = "instance";

/** Removes the tunnel service from a machine whose server was removed here. */
const TUNNEL_REMOVE_COMMAND = "sudo systemctl disable --now serve-tunnel; sudo pkill -f /etc/serve-tunnel/; sudo rm -rf /etc/serve-tunnel /etc/systemd/system/serve-tunnel.service";

export function AccessCard({
  server,
  organizations,
}: {
  server: Pick<ServerDetails, "id" | "name" | "isLocal" | "organizationIds" | "ownerOrganizationId" | "services" | "tunnel">;
  organizations: { id: string; name: string }[];
}) {
  return (
    <SettingsCard
      // The server may save other values than chosen (an owner change resets sharing): start over from what it saved.
      key={JSON.stringify([server.ownerOrganizationId, server.organizationIds])}
      title="Owner and sharing"
      description="Who manages this server, and which organizations may deploy to it. Only Root admins change this."
      initial={{ owner: server.ownerOrganizationId ?? INSTANCE, all: server.organizationIds === null, ids: server.organizationIds ?? [] }}
      onSave={(v) => updateServer(server.id, { ownerOrganizationId: v.owner === INSTANCE ? null : v.owner, organizationIds: v.all ? null : v.ids.filter((id) => id !== v.owner) })}
    >
      {(v, set) => (
        <>
          {!server.isLocal && (
            <Field
              label="Owner"
              description={
                v.owner !== INSTANCE
                  ? "Admins of this organization manage the server: its settings, proxy, terminal and private networks. It always deploys here."
                  : "Root admins manage the server."
              }
            >
              <Select
                value={v.owner}
                onValueChange={set("owner")}
                options={[{ value: INSTANCE, label: "The instance (Root admins)" }, ...organizations.map((o) => ({ value: o.id, label: o.name }))]}
              />
            </Field>
          )}
          <SwitchRow
            title="Share with every organization"
            description="Every organization, also ones created later, may deploy here."
            checked={v.all}
            onCheckedChange={set("all")}
          />
          {!v.all && (
            <Field label={v.owner !== INSTANCE ? "Also shared with" : "Shared with"}>
              <div className="flex flex-col divide-y divide-line overflow-hidden rounded-xl border border-line">
                {organizations
                  .filter((o) => o.id !== v.owner)
                  .map((o) => {
                    const checked = v.ids.includes(o.id);
                    return (
                      <label key={o.id} className="flex cursor-pointer items-center gap-3 px-3.5 py-2.5 text-[13px] hover:bg-surface-2">
                        <Checkbox checked={checked} onCheckedChange={(on) => set("ids")(on ? [...v.ids, o.id] : v.ids.filter((x) => x !== o.id))} />
                        <span className="truncate text-fg">{o.name}</span>
                      </label>
                    );
                  })}
                {v.owner === INSTANCE && v.ids.length === 0 && <p className="px-3.5 py-2.5 text-xs text-warn">No organization can deploy here.</p>}
              </div>
            </Field>
          )}
        </>
      )}
    </SettingsCard>
  );
}

export function DangerZone({ server }: { server: ServerDetails }) {
  const router = useRouter();
  const confirm = useConfirm();
  const remove = useAction((removeTailnetDevice: boolean) => deleteServer(server.id, { removeTailnetDevice }), { refresh: false, onSuccess: () => router.push("/servers") });
  return (
    <Card className="border-bad/25">
      <CardHeader title="Remove server" description={<>This server is forgotten. Containers already running there keep running until you stop them on the server.</>} />
      <CardBody className="flex flex-wrap items-center justify-between gap-3 py-4">
        <p className="text-[13px] text-muted">
          {server.services > 0
            ? `${server.services} service${server.services === 1 ? " runs" : "s run"} here. Move or delete ${server.services === 1 ? "it" : "them"} first.`
            : "No services run on this server."}
        </p>
        <Button
          variant="danger"
          size="sm"
          disabled={server.services > 0}
          loading={remove.pending}
          onClick={async () => {
            let removeDevice = false;
            if (
              await confirm({
                title: `Remove ${server.name}?`,
                children: server.tailnetDevice ? <RemoveDeviceChoice device={server.tailnetDevice} onChange={(v) => (removeDevice = v)} /> : undefined,
                description: server.tunnel ? (
                  <span className="flex flex-col gap-2">
                    <span>This cannot be undone. The server&apos;s tunnel can no longer sign in; to remove it from the machine, run there:</span>
                    <Copyable value={TUNNEL_REMOVE_COMMAND}>
                      <code className="block rounded-lg bg-sunken py-2 pr-9 pl-2.5 font-mono text-[11.5px] break-all text-fg select-all">{TUNNEL_REMOVE_COMMAND}</code>
                    </Copyable>
                  </span>
                ) : (
                  "This cannot be undone. You can add the server again later."
                ),
                confirmLabel: "Remove server",
                danger: true,
              })
            )
              void remove.run(removeDevice);
          }}
        >
          <Trash2 /> Remove server
        </Button>
      </CardBody>
    </Card>
  );
}

/** Whether removing the server also takes its device out of the tailnet; read when the dialog closes. */
function RemoveDeviceChoice({ device, onChange }: { device: string; onChange: (v: boolean) => void }) {
  const [on, setOn] = React.useState(false);
  return (
    <label className="mt-3 flex cursor-pointer items-start gap-2.5 text-[13px] text-fg">
      <Checkbox
        className="mt-0.5"
        checked={on}
        onCheckedChange={(v) => {
          setOn(!!v);
          onChange(!!v);
        }}
      />
      <span>
        Also remove its device <span className="font-mono">{device}</span> from the tailnet
      </span>
    </label>
  );
}
