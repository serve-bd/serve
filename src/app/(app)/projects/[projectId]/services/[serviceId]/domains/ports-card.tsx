"use client";

import * as React from "react";
import { ArrowUpRight, Laptop, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardFooter, CardHeader } from "@/components/ui/misc";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { useAction } from "@/hooks/use-action";
import { cn } from "@/lib/utils";
import { deployService, updateService } from "@/server/actions/services";
import type { PortMapping } from "@/server/services/types";

/** A port row; `service` names the compose service for compose stacks. */
type Row = PortMapping & { service?: string };
import type { PublishedPort } from "@/server/services/ports";

const digits = (value: string) => Number(value.replace(/\D/g, "")) || 0;

/**
 * Publish container ports on the server, e.g. to open an app at
 * localhost:3000 while developing on the machine Serve runs on.
 */
export function PortsCard({
  serviceId,
  kind = "app",
  composeServices = [],
  composePorts = {},
  appPort,
  initial,
  published,
  isLocalServer,
  serverName,
  busy,
}: {
  serviceId: string;
  kind?: "app" | "compose";
  /** Services of the compose stack, main service first. */
  composeServices?: string[];
  /** Container ports each compose service exposes, when known. */
  composePorts?: Record<string, number[]>;
  /** App port, or the main compose service's port. */
  appPort: number | null;
  initial: Row[];
  published: PublishedPort[];
  isLocalServer: boolean;
  serverName: string;
  /** Host ports other containers already publish on this server. */
  busy: number[];
}) {
  const [ports, setPorts] = React.useState<Row[]>(initial);
  const compose = kind === "compose";
  const pickService = compose && composeServices.length > 1;
  const defaultPort = (service?: string) => (service && composePorts[service]?.[0]) || appPort || (compose ? 80 : 3000);
  const [saved, setSaved] = React.useState(JSON.stringify(initial));
  const dirty = JSON.stringify(ports) !== saved;
  const valid = ports.filter((p) => p.host && p.container);
  const busySet = new Set(busy);
  const clash = ports.find((p) => busySet.has(p.host));
  const firstFree = (from: number) => {
    let port = from;
    while (busySet.has(port) || ports.some((p) => p.host === port)) port++;
    return port;
  };

  const save = useAction(
    async () => {
      const res = compose
        ? await updateService(serviceId, { compose: { ports: valid.map((p) => ({ ...p, service: p.service ?? composeServices[0] })) } })
        : await updateService(serviceId, { runtime: { ports: valid } });
      if (!res.ok) return res;
      return deployService(serviceId);
    },
    {
      success: "Ports saved. Redeploying to publish them.",
      onSuccess: () => {
        setPorts(valid);
        setSaved(JSON.stringify(valid));
      },
    },
  );

  const update = (i: number, patch: Partial<Row>) => setPorts((all) => all.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  // A blank row: the user types both ports; nothing is guessed.
  const add = () => {
    const service = compose ? composeServices[0] : undefined;
    setPorts((all) => [...all, { ...(service ? { service } : {}), host: 0, container: 0, protocol: "tcp", bindAddress: isLocalServer ? "127.0.0.1" : "0.0.0.0" }]);
  };
  const incomplete = ports.some((p) => !p.host || !p.container);

  return (
    <Card>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save.run();
        }}
      >
        <CardHeader
          title="Ports"
          description={
            isLocalServer
              ? "Open the app straight from this machine, like localhost:3000, without a domain. Useful while developing."
              : `Publish ports on ${serverName} for TCP or UDP traffic that does not go through a domain.`
          }
        />
        <CardBody className="flex flex-col gap-3 py-5">
          {published.length > 0 && !dirty && (
            <div className="flex flex-wrap gap-2">
              {published.map((p) =>
                p.url ? (
                  <a
                    key={`${p.host}/${p.protocol}`}
                    href={p.url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1.5 rounded-lg bg-accent-soft px-2.5 py-1.5 font-mono text-[12.5px] text-accent hover:underline"
                  >
                    {p.label}
                    <ArrowUpRight className="size-3.5" />
                  </a>
                ) : (
                  <span key={`${p.host}/${p.protocol}`} className="rounded-lg bg-surface-2 px-2.5 py-1.5 font-mono text-[12.5px] text-fg-2">
                    {p.label}/udp
                  </span>
                ),
              )}
            </div>
          )}

          {ports.length > 0 && (
            <div className={cn("hidden gap-2 px-0.5 text-[11px] font-medium tracking-wide text-faint uppercase sm:grid", pickService ? "grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1fr)_78px_150px_32px]" : "grid-cols-[minmax(0,1fr)_minmax(0,1fr)_78px_150px_32px]")}>
              {pickService && <span>Service</span>}
              <span>{isLocalServer ? "Local port" : "Server port"}</span>
              <span>Container port</span>
              <span>Protocol</span>
              <span>Reachable by</span>
              <span />
            </div>
          )}
          {ports.map((p, i) => (
            <div
              key={i}
              className={cn(
                "grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_32px] gap-2",
                pickService ? "sm:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1fr)_78px_150px_32px]" : "sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_78px_150px_32px]",
              )}
            >
              {pickService && (
                <div className="col-span-3 sm:col-span-1">
                  <Select
                    size="sm"
                    value={p.service ?? composeServices[0]}
                    onValueChange={(v) => update(i, { service: v, container: defaultPort(v) })}
                    options={composeServices.map((name) => ({ value: name, label: name }))}
                  />
                </div>
              )}
              <Input value={String(p.host || "")} onChange={(e) => update(i, { host: digits(e.target.value) })} placeholder="8080" aria-label="Server port" aria-invalid={busySet.has(p.host) || undefined} className="h-8 font-mono" inputMode="numeric" />
              <Input value={String(p.container || "")} onChange={(e) => update(i, { container: digits(e.target.value) })} placeholder={String(defaultPort(p.service))} aria-label="Container port" className="h-8 font-mono" inputMode="numeric" />
              <Button variant="ghost" size="icon" className="order-3 sm:order-5" onClick={() => setPorts((all) => all.filter((_, j) => j !== i))} aria-label="Remove port">
                <Trash2 />
              </Button>
              <div className="order-4 sm:order-3">
                <Select size="sm" value={p.protocol} onValueChange={(v) => update(i, { protocol: v as PortMapping["protocol"] })} options={[{ value: "tcp", label: "TCP" }, { value: "udp", label: "UDP" }]} />
              </div>
              <div className="order-5 col-span-2 sm:order-4 sm:col-span-1">
                <Select
                  size="sm"
                  value={p.bindAddress ?? "0.0.0.0"}
                  onValueChange={(v) => update(i, { bindAddress: v as PortMapping["bindAddress"] })}
                  options={[
                    { value: "127.0.0.1", label: "This machine", description: "localhost only" },
                    { value: "0.0.0.0", label: "Everyone", description: "Any network" },
                  ]}
                />
              </div>
            </div>
          ))}

          {ports.length === 0 && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-dashed border-line-strong px-4 py-3.5">
              <span className="flex min-w-0 items-center gap-3">
                <span className="flex size-9 flex-none items-center justify-center rounded-lg bg-surface-2 text-fg-2">
                  <Laptop className="size-4" />
                </span>
                <span className="text-[13px] text-muted">No ports published.</span>
              </span>
              <Button size="sm" onClick={add}>
                <Plus /> Add port
              </Button>
            </div>
          )}
          {clash && (
            <p className="text-xs text-warn">
              Port {clash.host} is already used on {isLocalServer ? "this machine" : serverName}. Try {firstFree(clash.host)}.
            </p>
          )}
          {ports.length > 0 && !clash && <p className="text-xs text-muted">One replica only: two containers cannot share a port.</p>}
        </CardBody>
        <CardFooter>
          <div className="flex min-w-0 items-center gap-3">
            {ports.length > 0 && (
              <Button size="sm" onClick={add}>
                <Plus /> Add port
              </Button>
            )}
            {dirty && <span className="truncate text-xs text-muted">Unsaved changes</span>}
          </div>
          <div className="flex flex-none gap-2">
            {dirty && (
              <Button type="button" variant="ghost" size="sm" onClick={() => setPorts(JSON.parse(saved))}>
                Discard
              </Button>
            )}
            <Button type="submit" variant="primary" size="sm" disabled={!dirty || !!clash || incomplete} loading={save.pending}>
              Save and redeploy
            </Button>
          </div>
        </CardFooter>
      </form>
    </Card>
  );
}
