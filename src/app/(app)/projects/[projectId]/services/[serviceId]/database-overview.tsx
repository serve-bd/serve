"use client";

import * as React from "react";
import { Globe, Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader, CopyField } from "@/components/ui/misc";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { StatusDot } from "@/components/ui/status";
import { useAction } from "@/hooks/use-action";
import { applyDatabaseChanges, updateService } from "@/server/actions/services";
import { useServiceLive } from "./service-header";

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
  serverIp: string | null;
}) {
  const { data } = useServiceLive(props.serviceId);
  const [publicOn, setPublicOn] = React.useState(!!props.publicPort);
  const [port, setPort] = React.useState(String(props.publicPort ?? props.engine.port + 10000));
  const apply = useAction(
    async () => {
      const res = await updateService(props.serviceId, { database: { publicPort: publicOn ? Number(port) : null } });
      if (!res.ok) return res;
      return applyDatabaseChanges(props.serviceId);
    },
    { success: "Applying changes. The database restarts briefly." },
  );
  const refName = props.name.toLowerCase();
  const changed = (publicOn ? Number(port) : null) !== props.publicPort;

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
      <div className="flex flex-col gap-6">
        <Card>
          <CardHeader title="Connect" description="Other services in this environment connect over the private network." />
          <CardBody className="flex flex-col gap-4">
            <Field label="Private connection URL">
              <CopyField value={props.internalUrl} secret />
            </Field>
            <div className="rounded-xl border border-line bg-surface-2 p-3.5 text-[13px] leading-relaxed text-muted">
              Reference it from another service&apos;s variables:{" "}
              <code className="rounded bg-sunken px-1.5 py-0.5 font-mono text-[12px] text-fg-2">{`DATABASE_URL=\${{${refName}.DATABASE_URL}}`}</code>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
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
            description="Expose the database on a port of this server, for example to connect from your laptop."
            actions={<Switch checked={publicOn} onCheckedChange={setPublicOn} />}
          />
          <CardBody className="flex flex-col gap-4">
            {publicOn ? (
              <>
                <Field label="Public port" description="Use a high, non-standard port and a strong password. Restrict access with a firewall when possible.">
                  <Input value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, ""))} className="max-w-40 font-mono" inputMode="numeric" />
                </Field>
                {props.publicUrl && !changed && (
                  <Field label="Public connection URL">
                    <CopyField value={props.publicUrl} secret />
                  </Field>
                )}
                {!props.serverIp && <p className="text-[13px] text-warn">Set the server IP in Server settings to see the public URL.</p>}
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
      </div>

      <Card className="h-fit">
        <CardHeader title={props.engine.label} description="Container status" />
        <div className="divide-y divide-line">
          {(data?.containers ?? []).map((c) => (
            <div key={c.id} className="flex items-center gap-3 px-5 py-3">
              <StatusDot status={c.state === "running" ? "running" : c.state === "restarting" ? "restarting" : "stopped"} />
              <div className="flex min-w-0 flex-col">
                <span className="truncate font-mono text-[12px] text-fg-2">{c.image}</span>
                <span className="text-[11px] text-faint">{c.status}</span>
              </div>
            </div>
          ))}
          {!data?.containers.length && <p className="px-5 py-4 text-[13px] text-muted">Starting soon…</p>}
        </div>
      </Card>
    </div>
  );
}
