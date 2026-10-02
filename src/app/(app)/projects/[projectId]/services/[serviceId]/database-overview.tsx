"use client";

import * as React from "react";
import Link from "next/link";
import { ChevronRight, GitBranch, Globe, Lock, Plus } from "lucide-react";
import { cn, formatBytes } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader, CopyField } from "@/components/ui/misc";
import { Field } from "@/components/ui/field";
import { Input, Textarea } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { StatusDot } from "@/components/ui/status";
import { useAction } from "@/hooks/use-action";
import { applyDatabaseChanges, updateService } from "@/server/actions/services";
import { inRanges, normalizeTrustedRanges } from "@/lib/trusted-proxies";
import { useServiceLive } from "./service-header";
import { SecretField } from "@/components/ui/secret-field";
import { ContainerDialog } from "./container-dialog";
import { DatabaseDomainCard, type DatabaseDomainInfo } from "./database-domain-card";

export function DatabaseOverview(props: {
  serviceId: string;
  projectId: string;
  name: string;
  engine: { label: string; port: number; hasUser: boolean; hasDatabase: boolean };
  creds: { username: string; password: string; database: string };
  internalUrl: string;
  publicUrl: string | null;
  host: string;
  publicPort: number | null;
  publicBind: "0.0.0.0" | "127.0.0.1";
  /** Addresses allowed to reach the public port; empty: everyone. */
  publicAllow: string[];
  /** The viewer's own address, offered for the allowlist. */
  viewerIp?: string | null;
  /** "address:port" the public port answers on, when enabled. */
  publicAddress: string | null;
  /** Uptime card: full width under the main cards once set up, else small in the side column. */
  uptime?: React.ReactNode;
  uptimeInSide?: boolean;
  /** The role cannot see secret values: the password and URLs are masked and not copyable. */
  hideSecrets?: boolean;
  canManage?: boolean;
  /** The database domain needs domains.manage, not services.manage. */
  canManageDomain?: boolean;
  domain?: DatabaseDomainInfo;
  /** Branches live inside this container, so they are listed under it. */
  branches?: { id: string; name: string; status: string; sizeBytes: number | null }[];
}) {
  const { data } = useServiceLive(props.serviceId);
  const [openContainer, setOpenContainer] = React.useState<string | null>(null);
  const [publicOn, setPublicOn] = React.useState(!!props.publicPort);
  const [port, setPort] = React.useState(String(props.publicPort ?? props.engine.port + 10000));
  const [bind, setBind] = React.useState(props.publicBind);
  const [allow, setAllow] = React.useState(props.publicAllow.join("\n"));
  // Saved settings changed elsewhere (a domain opens or closes the port): the form shows them.
  const saved = `${props.publicPort}|${props.publicBind}|${props.publicAllow.join(",")}`;
  const [lastSaved, setLastSaved] = React.useState(saved);
  if (saved !== lastSaved) {
    setLastSaved(saved);
    setPublicOn(!!props.publicPort);
    setPort(String(props.publicPort ?? props.engine.port + 10000));
    setBind(props.publicBind);
    setAllow(props.publicAllow.join("\n"));
  }
  const allowList = allow
    .split(/[\s,]+/)
    .map((a) => a.trim())
    .filter(Boolean);
  // The form the server stores (203.0.113.7 → 203.0.113.7/32), to compare with what is saved.
  const parsedAllow = normalizeTrustedRanges(allowList, { anyWidth: true });
  const allowNormalized = "ranges" in parsedAllow ? parsedAllow.ranges : allowList;
  // No toast: the card and the status show the restart.
  const apply = useAction(async () => {
    const res = await updateService(props.serviceId, { database: { publicPort: publicOn ? Number(port) : null, publicBind: bind, publicAllow: allowList } });
    if (!res.ok) return res;
    return applyDatabaseChanges(props.serviceId);
  });
  const changed =
    (publicOn ? Number(port) : null) !== props.publicPort ||
    (publicOn && bind !== props.publicBind) ||
    (publicOn && bind === "0.0.0.0" && allowNormalized.join(",") !== props.publicAllow.join(","));

  return (
    <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
      <div className="flex flex-col gap-6">
        <Card>
          <CardHeader title="Connect" description="Other services in this environment connect over the private network." />
          <CardBody className="flex flex-col gap-4">
            <Field label="Private connection URL">
              <SecretField value={props.internalUrl} hidden={props.hideSecrets} shape={props.internalUrl} />
            </Field>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Host">
                <CopyField value={props.host} />
              </Field>
              <Field label="Port">
                <CopyField value={String(props.engine.port)} />
              </Field>
              {props.engine.hasUser && (
                <Field label="Username">
                  <CopyField value={props.creds.username} />
                </Field>
              )}
              <Field label="Password">
                <SecretField value={props.creds.password} hidden={props.hideSecrets} />
              </Field>
              {props.engine.hasDatabase && (
                <Field label="Database">
                  <CopyField value={props.creds.database} />
                </Field>
              )}
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Public access"
            description="Publish the database on a port of its server, for example to connect with a desktop client."
            actions={<Switch checked={publicOn} onCheckedChange={setPublicOn} disabled={props.canManage === false} />}
          />
          <CardBody className="flex flex-col gap-4">
            {publicOn ? (
              <>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-[160px_minmax(0,1fr)]">
                  <Field label="Port">
                    <Input
                      value={port}
                      onChange={(e) => setPort(e.target.value.replace(/\D/g, ""))}
                      className="font-mono"
                      inputMode="numeric"
                      disabled={props.canManage === false}
                    />
                  </Field>
                  <Field label="Reachable by">
                    <Select
                      value={bind}
                      onValueChange={(b) => setBind(b as typeof bind)}
                      disabled={props.canManage === false}
                      options={[
                        { value: "127.0.0.1", label: "This machine", description: "localhost on the server only, safest" },
                        { value: "0.0.0.0", label: "Everyone", description: "Any network that reaches the server" },
                      ]}
                    />
                  </Field>
                </div>
                {bind === "127.0.0.1" ? (
                  <p className="text-[12.5px] leading-relaxed text-muted">Connect at localhost on the server, or through an SSH tunnel from your laptop.</p>
                ) : (
                  <Field
                    label="Allowed IPs"
                    error={"error" in parsedAllow ? parsedAllow.error : undefined}
                    description={
                      allowList.length
                        ? "Only these addresses can connect. The server's firewall drops everyone else, even past ufw."
                        : "Empty: anyone can connect, with the password. Add addresses or ranges (203.0.113.7, 10.0.0.0/8) to let only them in."
                    }
                  >
                    <Textarea
                      value={allow}
                      onChange={(e) => setAllow(e.target.value)}
                      rows={3}
                      spellCheck={false}
                      placeholder={"203.0.113.7\n198.51.100.0/24"}
                      className="font-mono text-[12.5px]"
                      disabled={props.canManage === false}
                    />
                    {props.viewerIp && !inRanges(props.viewerIp, allowNormalized) && props.canManage !== false && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="mt-1.5 self-start"
                        onClick={() => setAllow((a) => (a.trim() ? `${a.trim()}\n` : "") + props.viewerIp)}
                      >
                        <Plus /> Add my IP ({props.viewerIp})
                      </Button>
                    )}
                  </Field>
                )}
                {props.publicUrl && !changed && (
                  <Field label={`Public connection URL · ${props.publicAddress}`}>
                    <SecretField value={props.publicUrl} hidden={props.hideSecrets} shape={props.publicUrl} />
                  </Field>
                )}
              </>
            ) : (
              <p className="flex items-center gap-2 text-[13px] text-muted">
                <Lock className="size-3.5" /> Only reachable from services in this project environment.
              </p>
            )}
            {changed && (
              <div className="flex justify-end">
                <Button variant="primary" size="sm" onClick={() => apply.run()} loading={apply.pending}>
                  <Globe /> Apply and restart
                </Button>
              </div>
            )}
          </CardBody>
        </Card>
        {props.domain && (
          <DatabaseDomainCard
            serviceId={props.serviceId}
            info={props.domain}
            hideSecrets={props.hideSecrets}
            canManage={props.canManageDomain}
            canManageAllow={props.canManage}
            viewerIp={props.viewerIp}
          />
        )}
        {!props.uptimeInSide && props.uptime}
      </div>

      <div className="flex min-w-0 flex-col gap-6">
        <Card className="h-fit">
          <CardHeader title={props.engine.label} description="Container status" />
          <div className="divide-y divide-line">
            {(data?.containers ?? []).map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => setOpenContainer(c.id)}
                className="group flex w-full items-center gap-3 px-5 py-3 text-left transition-colors hover:bg-hover"
              >
                <StatusDot status={c.state === "running" ? "running" : c.state === "restarting" ? "restarting" : "stopped"} />
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate font-mono text-[12px] text-fg-2">{c.image}</span>
                  <span className="text-[11px] text-faint">{c.status}</span>
                </div>
                <ChevronRight className="size-3.5 flex-none text-faint transition-colors group-hover:text-muted" />
              </button>
            ))}
            {!data?.containers.length && (
              <p className="px-5 py-4 text-[13px] text-muted">
                {data?.status === "idle" ? "Not deployed yet. Click Deploy to start it." : data?.status === "stopped" ? "Stopped." : "Starting soon…"}
              </p>
            )}
            {!!props.branches?.length && (
              <div className="flex flex-col py-2">
                <span className="px-5 pt-1 pb-1.5 text-[11px] font-medium tracking-wide text-faint uppercase">Branches in this container</span>
                {props.branches.map((b) => (
                  <Link
                    key={b.id}
                    href={`/projects/${props.projectId}/services/${props.serviceId}/branches`}
                    className="group flex items-center gap-3 px-5 py-2 transition-colors hover:bg-hover"
                  >
                    <GitBranch className="size-3.5 flex-none text-muted" />
                    <span className="min-w-0 flex-1 truncate text-[13px] text-fg-2">{b.name}</span>
                    <span className={cn("flex-none text-[11px]", b.status === "failed" ? "text-bad" : "text-faint")}>
                      {b.status === "ready" ? (b.sizeBytes !== null ? formatBytes(b.sizeBytes) : "Ready") : b.status === "failed" ? "Failed" : "Copying…"}
                    </span>
                  </Link>
                ))}
              </div>
            )}
          </div>
        </Card>
        {props.uptimeInSide && props.uptime}
        <ContainerDialog
          serviceId={props.serviceId}
          base={`/projects/${props.projectId}/services/${props.serviceId}`}
          containerId={openContainer}
          onOpenChange={(o) => !o && setOpenContainer(null)}
        />
      </div>
    </div>
  );
}
