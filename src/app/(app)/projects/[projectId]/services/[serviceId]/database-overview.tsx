"use client";

import * as React from "react";
import { ChevronRight, Globe, Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader, CopyField } from "@/components/ui/misc";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { StatusDot } from "@/components/ui/status";
import { useAction } from "@/hooks/use-action";
import { applyDatabaseChanges, updateService } from "@/server/actions/services";
import { useServiceLive } from "./service-header";
import { ContainerDialog } from "./container-dialog";

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
  /** "address:port" the public port answers on, when enabled. */
  publicAddress: string | null;
  /** Uptime card: full width under the main cards once set up, else small in the side column. */
  uptime?: React.ReactNode;
  uptimeInSide?: boolean;
}) {
  const { data } = useServiceLive(props.serviceId);
  const [openContainer, setOpenContainer] = React.useState<string | null>(null);
  const [publicOn, setPublicOn] = React.useState(!!props.publicPort);
  const [port, setPort] = React.useState(String(props.publicPort ?? props.engine.port + 10000));
  const [bind, setBind] = React.useState(props.publicBind);
  const apply = useAction(
    async () => {
      const res = await updateService(props.serviceId, { database: { publicPort: publicOn ? Number(port) : null, publicBind: bind } });
      if (!res.ok) return res;
      return applyDatabaseChanges(props.serviceId);
    },
    { success: "Applying changes. The database restarts briefly." },
  );
  const changed = (publicOn ? Number(port) : null) !== props.publicPort || (publicOn && bind !== props.publicBind);

  return (
    <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
      <div className="flex flex-col gap-6">
        <Card>
          <CardHeader title="Connect" description="Other services in this environment connect over the private network." />
          <CardBody className="flex flex-col gap-4">
            <Field label="Private connection URL">
              <CopyField value={props.internalUrl} secret />
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
                <CopyField value={props.creds.password} secret />
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
            actions={<Switch checked={publicOn} onCheckedChange={setPublicOn} />}
          />
          <CardBody className="flex flex-col gap-4">
            {publicOn ? (
              <>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-[160px_minmax(0,1fr)]">
                  <Field label="Port">
                    <Input value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, ""))} className="font-mono" inputMode="numeric" />
                  </Field>
                  <Field label="Reachable by">
                    <Select
                      value={bind}
                      onValueChange={(b) => setBind(b as typeof bind)}
                      options={[
                        { value: "127.0.0.1", label: "This machine", description: "localhost on the server only, safest" },
                        { value: "0.0.0.0", label: "Everyone", description: "Any network that reaches the server" },
                      ]}
                    />
                  </Field>
                </div>
                <p className="text-[12.5px] leading-relaxed text-muted">
                  {bind === "127.0.0.1"
                    ? "Connect at localhost on the server, or through an SSH tunnel from your laptop."
                    : "Use a high, non-standard port and a strong password. Restrict access with a firewall when possible."}
                </p>
                {props.publicUrl && !changed && (
                  <Field label={`Public connection URL · ${props.publicAddress}`}>
                    <CopyField value={props.publicUrl} secret />
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
            {!data?.containers.length && <p className="px-5 py-4 text-[13px] text-muted">Starting soon…</p>}
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
