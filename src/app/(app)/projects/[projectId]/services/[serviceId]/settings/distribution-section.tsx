"use client";

import * as React from "react";
import Link from "next/link";
import { Info, Rocket, Server } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardBody, CardFooter, CardHeader } from "@/components/ui/misc";
import { Checkbox } from "@/components/ui/checkbox";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { SwitchRow } from "@/components/ui/switch";
import { useAction } from "@/hooks/use-action";
import { useRouter } from "@/hooks/use-router";
import { saveDistribution } from "@/server/actions/registries";
import { DEFAULT_TAG, defaultRepository, renderTag } from "@/server/registries/refs";
import type { Distribution } from "@/server/deploy/distribution";
import type { DeploymentTarget } from "@/server/services/types";
import { cn } from "@/lib/utils";

type ServerOption = { id: string; name: string; status: string; isLocal: boolean };
type RegistryOption = { id: string; name: string; host: string; namespace: string | null; username: string };

const statusTone: Record<DeploymentTarget["status"], "ok" | "bad" | "warn" | "neutral" | "info"> = {
  success: "ok",
  failed: "bad",
  skipped: "warn",
  deploying: "info",
  pending: "neutral",
};
const statusLabel: Record<DeploymentTarget["status"], string> = { success: "Running", failed: "Failed", skipped: "Skipped", deploying: "Deploying", pending: "Waiting" };

/** Where an app builds and runs: build server, registry, and extra servers that run the same image. */
export function DistributionSection(props: {
  serviceId: string;
  projectId: string;
  slug: string;
  gitSource: boolean;
  primary: { id: string; name: string };
  servers: ServerOption[];
  registries: RegistryOption[];
  initial: Distribution;
  last: { deploymentId: string; targets: DeploymentTarget[] | null; registryImage: string | null } | null;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [value, setValue] = React.useState(props.initial);
  const [saved, setSaved] = React.useState(JSON.stringify(props.initial));
  const dirty = JSON.stringify(value) !== saved;
  const set = (patch: Partial<Distribution>) => setValue((v) => ({ ...v, ...patch }));
  const save = useAction((deploy: boolean) => saveDistribution(props.serviceId, value, { deploy }), {
    success: "Saved",
    onSuccess: (r) => {
      setSaved(JSON.stringify(value));
      if (r.deploymentId) router.push(`/projects/${props.projectId}/services/${props.serviceId}/deployments/${r.deploymentId}`);
    },
  });

  const others = props.servers.filter((s) => s.id !== props.primary.id);
  const registry = props.registries.find((r) => r.id === value.registryId) ?? null;
  const repoPlaceholder = registry ? defaultRepository(registry, props.slug) : "team/app";
  const tagPreview = renderTag(value.tag, { commit: "4f2a9c1e8b7d", deployment: "k3j9x2pq", branch: "main", service: props.slug });
  const needsRegistry = props.gitSource && (!!value.buildServerId || value.extraServerIds.length > 0);
  const targetOf = (id: string) => props.last?.targets?.find((t) => t.serverId === id);
  const toggleExtra = (id: string, on: boolean) => set({ extraServerIds: on ? [...value.extraServerIds, id] : value.extraServerIds.filter((x) => x !== id) });

  return (
    <div className="flex flex-col gap-6">
      <Card id="servers" className="scroll-mt-6">
        <CardHeader title="Servers" description={`${props.primary.name} runs this app and keeps its domains, logs and metrics. Extra servers run the same image next to it.`} />
        <CardBody className="flex flex-col gap-1 py-4">
          <ServerRow name={props.primary.name} note="Service's server" checked disabled target={targetOf(props.primary.id)} />
          {others.map((s) => (
            <ServerRow
              key={s.id}
              name={s.name}
              note={s.status !== "ready" && !s.isLocal ? `Not ready (${s.status})` : s.isLocal ? "This server" : undefined}
              checked={value.extraServerIds.includes(s.id)}
              disabled={!props.canEdit || (s.status !== "ready" && !s.isLocal)}
              onChange={(on) => toggleExtra(s.id, on)}
              target={value.extraServerIds.includes(s.id) ? targetOf(s.id) : undefined}
            />
          ))}
          {others.length === 0 && (
            <p className="flex items-center gap-2 py-2 text-[13px] text-muted">
              <Server className="size-4 text-faint" /> Add another server in{" "}
              <Link href="/servers" className="text-accent hover:underline">
                Servers
              </Link>{" "}
              to run this app on more than one machine.
            </p>
          )}
        </CardBody>
      </Card>

      {props.gitSource && (
        <Card>
          <CardHeader title="Build" description="Where the image is built. A separate build server keeps heavy builds away from the servers that serve traffic." />
          <CardBody className="flex flex-col gap-4 py-5">
            <Field label="Build server">
              <Select
                value={value.buildServerId ?? ""}
                onValueChange={(v) => set({ buildServerId: v || null })}
                disabled={!props.canEdit}
                options={[
                  { value: "", label: `${props.primary.name} (the service's server)` },
                  ...others.map((s) => ({ value: s.id, label: s.name, disabled: s.status !== "ready" && !s.isLocal })),
                ]}
              />
            </Field>
          </CardBody>
        </Card>
      )}

      <Card>
        <CardHeader
          title="Registry"
          description={
            props.gitSource
              ? "After each build, Serve pushes the image here. Every server pulls exactly that image, and rollbacks pull it again without rebuilding."
              : "This app runs a prebuilt image, so each server pulls it from its own registry. A registry here is not needed."
          }
        />
        <CardBody className="flex flex-col gap-4 py-5">
          <Field
            label="Push to"
            description={
              props.registries.length ? (
                needsRegistry && !value.registryId ? (
                  <span className="text-warn">Needed: the image has to travel to another server.</span>
                ) : undefined
              ) : (
                <>
                  No registries yet.{" "}
                  <Link href="/integrations/registries" className="text-accent hover:underline">
                    Add one
                  </Link>
                  .
                </>
              )
            }
          >
            <Select
              value={value.registryId ?? ""}
              onValueChange={(v) => set({ registryId: v || null })}
              disabled={!props.canEdit || !props.gitSource}
              options={[{ value: "", label: "Don't push" }, ...props.registries.map((r) => ({ value: r.id, label: r.name, description: r.host }))]}
            />
          </Field>
          {registry && props.gitSource && (
            <>
              <Field label="Repository" description={`Pushed as ${registry.host}/${value.repository || repoPlaceholder}.`}>
                <Input
                  value={value.repository ?? ""}
                  onChange={(e) => set({ repository: e.target.value || null })}
                  placeholder={repoPlaceholder}
                  className="font-mono text-[13px]"
                  disabled={!props.canEdit}
                />
              </Field>
              <Field label="Tag" description={`Use {commit}, {short}, {deployment}, {branch}, {service} and {date}. Next tag looks like ${tagPreview}.`}>
                <Input
                  value={value.tag ?? ""}
                  onChange={(e) => set({ tag: e.target.value || null })}
                  placeholder={DEFAULT_TAG}
                  className="font-mono text-[13px]"
                  disabled={!props.canEdit}
                />
              </Field>
              <SwitchRow
                title="Also tag as latest"
                description="Moves the latest tag to every new image, for tools outside Serve."
                checked={value.tagLatest}
                onCheckedChange={(c) => set({ tagLatest: c })}
                disabled={!props.canEdit}
              />
            </>
          )}
          {props.last?.registryImage && (
            <p className="truncate font-mono text-[12px] text-muted" title={props.last.registryImage}>
              Running: {props.last.registryImage}
            </p>
          )}
        </CardBody>
      </Card>

      {/* One save for the three cards above: they describe a single setup. */}
      <Card className={cn("sticky bottom-4 z-10 transition-shadow", dirty && "shadow-lg")}>
        <CardFooter className="border-t-0">
          <span className="truncate text-xs text-muted">
            {dirty ? "Unsaved changes" : "Changes apply on the next deployment. Servers you untick stop running this app when you save."}
          </span>
          <div className="flex flex-none gap-2">
            {dirty && (
              <Button type="button" variant="ghost" size="sm" onClick={() => setValue(JSON.parse(saved))}>
                Discard
              </Button>
            )}
            <Button type="button" size="sm" disabled={!dirty || !props.canEdit} loading={save.pending} onClick={() => save.run(false)}>
              Save
            </Button>
            <Button type="button" variant="primary" size="sm" disabled={!dirty || !props.canEdit} loading={save.pending} onClick={() => save.run(true)}>
              <Rocket /> Save and deploy
            </Button>
          </div>
        </CardFooter>
      </Card>

      {value.extraServerIds.length > 0 && (
        <Card className="border-info/25">
          <div className="flex gap-3 px-5 py-4 text-[13px] leading-5 text-fg-2">
            <Info className="mt-0.5 size-4 flex-none text-info" />
            <div className="flex flex-col gap-2">
              <p className="font-medium text-fg">Before you run on several servers</p>
              <ul className="flex list-disc flex-col gap-1.5 pl-4">
                <li>
                  <span className="text-fg">Domains:</span> every server answers for this app&apos;s domains. Point DNS at each server (one A record per server) or put a load
                  balancer in front. Cloudflare Tunnel domains only reach the service&apos;s own server.
                </li>
                <li>
                  <span className="text-fg">HTTPS:</span> with Caddy or Traefik each server gets its own certificate. With nginx, a server without a certificate of its own serves
                  plain HTTP.
                </li>
                <li>
                  <span className="text-fg">Private network:</span> databases and other services of this environment stay on {props.primary.name}. Their private hostnames only work
                  there, so apps on other servers need a public address or a private network between servers.
                </li>
                <li>
                  <span className="text-fg">Data:</span> each server has its own volumes. Nothing is shared or synced between them.
                </li>
                <li>
                  <span className="text-fg">Pre-deploy command:</span> runs once, on {props.primary.name}. Logs, metrics and the console show {props.primary.name}.
                </li>
              </ul>
            </div>
          </div>
        </Card>
      )}
    </div>
  );
}

function ServerRow({
  name,
  note,
  checked,
  disabled,
  onChange,
  target,
}: {
  name: string;
  note?: string;
  checked: boolean;
  disabled?: boolean;
  onChange?: (on: boolean) => void;
  target?: DeploymentTarget;
}) {
  return (
    <label className={cn("flex items-center gap-3 rounded-lg px-2 py-2 transition-colors", !disabled && "cursor-pointer hover:bg-fg/[0.03]")}>
      <Checkbox checked={checked} disabled={disabled} onCheckedChange={(c) => onChange?.(!!c)} />
      <Server className="size-4 flex-none text-faint" />
      <span className="min-w-0 flex-1 truncate text-[14px] text-fg">{name}</span>
      {note && <span className="flex-none text-xs text-muted">{note}</span>}
      {target && (
        <Badge tone={statusTone[target.status]} title={target.error ?? undefined}>
          {statusLabel[target.status]}
        </Badge>
      )}
    </label>
  );
}
