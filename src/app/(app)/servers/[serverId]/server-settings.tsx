"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "@/hooks/use-router";
import { Fingerprint, PlugZap, RotateCcw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader, TimeAgo } from "@/components/ui/misc";
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
import { ProductName } from "@/components/brand";

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
  services: number;
};

export function ConnectionSettings({ server, keys }: { server: ServerDetails; keys: { id: string; name: string }[] }) {
  if (server.isLocal) {
    return (
      <SettingsCard
        title="Details"
        description={
          <>
            How this server appears in <ProductName />.
          </>
        }
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
            <Field label="IP address or hostname">
              <Input value={v.host} onChange={(e) => set("host")(e.target.value)} className="font-mono" spellCheck={false} />
            </Field>
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
          <Field
            label="Data directory"
            description={
              <>
                Where <ProductName /> keeps repositories, proxy configuration and certificates on this server.
              </>
            }
          >
            <Input value={v.dataDir} onChange={(e) => set("dataDir")(e.target.value)} className="font-mono sm:max-w-sm" spellCheck={false} />
          </Field>
        </>
      )}
    </SettingsCard>
  );
}

export function ValidationCard({ server }: { server: ServerDetails }) {
  const router = useRouter();
  const confirm = useConfirm();
  const [watching, setWatching] = React.useState(server.status === "validating" || server.status !== "ready");
  const validate = useAction((installDocker: boolean) => validateServer(server.id, { installDocker }), { onSuccess: () => setWatching(true) });
  const reset = useAction(() => resetHostKey(server.id), { success: "Host key reset. Validate to pin the new key." });

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
          <ServerSetupProgress key={`${validate.pending ? "pending" : "watch"}|${server.status}`} serverId={server.id} compact />
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

/** How much this server builds at once, and how long it keeps images and metrics. */
export function BuildsLimitsCard({ serverId, limits }: { serverId: string; limits: { buildConcurrency: number; imageRetention: number; metricsRetentionHours: number } }) {
  return (
    <SettingsCard
      title="Builds and limits"
      description="For this server: builds it runs at once, and how long it keeps images and metrics. Max upload size is on the Proxy page."
      initial={{ builds: String(limits.buildConcurrency), images: String(limits.imageRetention), hours: String(limits.metricsRetentionHours) }}
      onSave={(v) => updateServer(serverId, { buildConcurrency: count(v.builds), imageRetention: count(v.images), metricsRetentionHours: count(v.hours) })}
    >
      {(v, set) => (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Field label="Concurrent builds" description="Builds this server runs at once. More need more CPU and memory; the rest wait.">
            <Input value={v.builds} onChange={(e) => set("builds")(e.target.value.replace(/\D/g, ""))} inputMode="numeric" />
          </Field>
          <Field label="Images kept per service" description="Older images are removed. Each kept one allows an instant rollback.">
            <Input value={v.images} onChange={(e) => set("images")(e.target.value.replace(/\D/g, ""))} inputMode="numeric" />
          </Field>
          <Field label="Metrics history" description="CPU, memory and request metrics of this server and its services.">
            <InputGroup suffix="hours">
              <Input value={v.hours} onChange={(e) => set("hours")(e.target.value.replace(/\D/g, ""))} inputMode="numeric" />
            </InputGroup>
          </Field>
        </div>
      )}
    </SettingsCard>
  );
}

export function AccessCard({ server, organizations }: { server: ServerDetails; organizations: { id: string; name: string }[] }) {
  return (
    <SettingsCard
      title="Organization access"
      description="Which organizations may deploy services to this server."
      initial={{ all: server.organizationIds === null, ids: server.organizationIds ?? [] }}
      onSave={(v) => updateServer(server.id, { organizationIds: v.all ? null : v.ids })}
    >
      {(v, set) => (
        <>
          <SwitchRow title="Every organization" description="New organizations get access automatically." checked={v.all} onCheckedChange={set("all")} />
          {!v.all && (
            <div className="flex flex-col divide-y divide-line overflow-hidden rounded-xl border border-line">
              {organizations.map((o) => {
                const checked = v.ids.includes(o.id);
                return (
                  <label key={o.id} className="flex cursor-pointer items-center gap-3 px-3.5 py-2.5 text-[13px] hover:bg-surface-2">
                    <Checkbox checked={checked} onCheckedChange={(on) => set("ids")(on ? [...v.ids, o.id] : v.ids.filter((x) => x !== o.id))} />
                    <span className="truncate text-fg">{o.name}</span>
                  </label>
                );
              })}
              {v.ids.length === 0 && <p className="px-3.5 py-2.5 text-xs text-warn">No organization can deploy here.</p>}
            </div>
          )}
        </>
      )}
    </SettingsCard>
  );
}

export function DangerZone({ server }: { server: ServerDetails }) {
  const router = useRouter();
  const confirm = useConfirm();
  const remove = useAction(() => deleteServer(server.id), { success: `${server.name} removed`, refresh: false, onSuccess: () => router.push("/servers") });
  return (
    <Card className="border-bad/25">
      <CardHeader
        title="Remove server"
        description={
          <>
            <ProductName /> forgets this server. Containers already running there keep running until you stop them on the server.
          </>
        }
      />
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
            if (
              await confirm({
                title: `Remove ${server.name}?`,
                description: server.tunnel ? (
                  <span className="flex flex-col gap-2">
                    <span>This cannot be undone. The server&apos;s tunnel can no longer sign in; to remove it from the machine, run there:</span>
                    <code className="rounded-lg bg-sunken px-2.5 py-2 font-mono text-[11.5px] break-all text-fg select-all">
                      sudo systemctl disable --now serve-tunnel; sudo pkill -f /etc/serve-tunnel/; sudo rm -rf /etc/serve-tunnel /etc/systemd/system/serve-tunnel.service
                    </code>
                  </span>
                ) : (
                  "This cannot be undone. You can add the server again later."
                ),
                confirmLabel: "Remove server",
                danger: true,
              })
            )
              void remove.run();
          }}
        >
          <Trash2 /> Remove server
        </Button>
      </CardBody>
    </Card>
  );
}
