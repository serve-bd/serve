"use client";

import * as React from "react";
import Link from "next/link";
import { ChevronRight, GitBranch, Globe, Lock } from "lucide-react";
import { cn, formatBytes } from "@/lib/utils";
import { Card, CardBody, CardHeader, CopyField } from "@/components/ui/misc";
import { Field } from "@/components/ui/field";
import { StatusDot } from "@/components/ui/status";
import { useServiceLive } from "./service-header";
import { SecretField } from "@/components/ui/secret-field";
import { ContainerDialog } from "./container-dialog";
import { Select } from "@/components/ui/select";
import { useAction } from "@/hooks/use-action";
import { mainDatabaseChoices, setMainDatabase } from "@/server/actions/databases";
import type { DatabaseDomainInfo } from "./database-domain-card";

export function DatabaseOverview(props: {
  serviceId: string;
  projectId: string;
  name: string;
  engine: { label: string; port: number; hasUser: boolean; hasDatabase: boolean };
  creds: { username: string; password: string; database: string };
  internalUrl: string;
  /** Through the connection pooler, and to the read replicas: while they are on. */
  poolerUrl?: string | null;
  replicaUrl?: string | null;
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
  // The other databases on the server: pick one to copy a URL to it, or make it the main one.
  const [databases, setDatabases] = React.useState<string[]>([]);
  const [db, setDb] = React.useState(props.creds.database);
  React.useEffect(() => {
    if (!props.canManage || !props.engine.hasDatabase) return;
    void mainDatabaseChoices(props.serviceId).then((r) => r.ok && setDatabases(r.data.databases));
  }, [props.serviceId, props.canManage, props.engine.hasDatabase]);
  const makeMain = useAction((name: string) => setMainDatabase(props.serviceId, name), {});
  // The same URL, naming the chosen database (its last path part; the user name may match it).
  const swap = (url: string) => (db === props.creds.database ? url : url.replace(/\/[^/?]*(?=\?|$)/, `/${encodeURIComponent(db)}`));
  return (
    <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
      <div className="flex flex-col gap-6">
        <Card>
          <CardHeader title="Connect" description="Other services in this environment connect over the private network." />
          <CardBody className="flex flex-col gap-4">
            <Field label="Private connection URL">
              <SecretField value={swap(props.internalUrl)} hidden={props.hideSecrets} shape={swap(props.internalUrl)} />
            </Field>
            {props.poolerUrl && (
              <Field label="Pooled connection URL" description="Through the connection pooler: for apps that open many short connections.">
                <SecretField value={swap(props.poolerUrl)} hidden={props.hideSecrets} shape={swap(props.poolerUrl)} />
              </Field>
            )}
            {props.replicaUrl && (
              <Field label="Read replica URL" description="Reads only: spreads read queries over the replicas.">
                <SecretField value={swap(props.replicaUrl)} hidden={props.hideSecrets} shape={swap(props.replicaUrl)} />
              </Field>
            )}
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
                <Field
                  label="Database"
                  description={
                    db !== props.creds.database ? (
                      <>
                        The URL above names {db}; apps get {props.creds.database}.{" "}
                        <button type="button" className="text-accent hover:underline" disabled={makeMain.pending} onClick={() => makeMain.run(db)}>
                          Make {db} the main database
                        </button>
                      </>
                    ) : undefined
                  }
                >
                  {databases.length > 1 ? (
                    <Select
                      value={db}
                      onValueChange={setDb}
                      options={databases.map((d) => ({ value: d, label: d, description: d === props.creds.database ? "Main database" : undefined }))}
                      className="font-mono"
                    />
                  ) : (
                    <CopyField value={props.creds.database} />
                  )}
                </Field>
              )}
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Public access"
            description={props.publicAddress || props.domain?.hostname ? "Reachable from outside Serve." : "Only reachable from services in this project environment."}
            actions={
              <Link href={`/projects/${props.projectId}/services/${props.serviceId}/settings/public-access`} className="text-[13px] text-accent hover:underline">
                Manage
              </Link>
            }
          />
          {(props.publicAddress || props.domain?.hostname) && (
            <CardBody className="flex flex-col gap-1.5 text-[13px] text-fg-2">
              {props.domain?.hostname && (
                <span className="flex items-center gap-2">
                  <Globe className="size-3.5 text-muted" /> {props.domain.hostname}
                </span>
              )}
              {props.publicAddress && (
                <span className="flex items-center gap-2">
                  <Lock className="size-3.5 text-muted" /> Port {props.publicAddress}
                  {props.publicAllow.length ? ` · ${props.publicAllow.length} allowed address${props.publicAllow.length === 1 ? "" : "es"}` : " · open to everyone"}
                </span>
              )}
            </CardBody>
          )}
        </Card>
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
