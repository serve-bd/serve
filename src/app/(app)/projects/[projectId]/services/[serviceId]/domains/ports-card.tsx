"use client";

import { useCan } from "@/components/permissions";
import { ReadOnlyFooter } from "@/components/read-only";
import * as React from "react";
import { ArrowUpRight, Check, ChevronRight, Laptop, Plus, Trash2 } from "lucide-react";
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
import type { ListeningPort, PublishedPort } from "@/server/services/ports";

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
  listening = {},
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
  /** Ports the running containers listen on, per compose service ("" for an app). */
  listening?: Record<string, ListeningPort[]>;
}) {
  const can = useCan();
  // Ports are saved in the service settings; publishing them takes a deploy.
  const canEdit = can("services.manage");
  const canDeploy = can("services.deploy");
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

  // Ports each service can expose: what its containers listen on, plus what the file or app settings name.
  const available = (compose ? composeServices : [""])
    .map((name) => {
      const list: ListeningPort[] = [...(listening[name] ?? [])];
      const known = compose ? (composePorts[name] ?? []) : appPort ? [appPort] : [];
      for (const port of known) if (!list.some((l) => l.port === port && l.protocol === "tcp")) list.push({ port, protocol: "tcp" });
      return { name, ports: list.sort((a, b) => a.port - b.port) };
    })
    .filter((g) => g.ports.length);
  const mapped = (name: string, l: ListeningPort) =>
    ports.some((p) => p.container === l.port && p.protocol === l.protocol && (!compose || (p.service ?? composeServices[0]) === name));
  // Same number on the server when it is free and not a system port; else the next free one.
  const hostFor = (port: number) => firstFree(port >= 1024 ? port : 8000 + port);
  const expose = (name: string, l: ListeningPort) => {
    const service = compose ? name : undefined;
    const open = ports.findIndex((p) => !p.container && (!compose || (p.service ?? composeServices[0]) === name));
    if (open >= 0) {
      update(open, { container: l.port, protocol: l.protocol, host: ports[open].host || hostFor(l.port) });
      return;
    }
    setPorts((all) => [
      ...all,
      { ...(service ? { service } : {}), host: hostFor(l.port), container: l.port, protocol: l.protocol, bindAddress: isLocalServer ? "127.0.0.1" : "0.0.0.0" },
    ]);
  };
  const taken = busy.filter((p) => p > 0);
  const busyCount = taken.length;

  const deploy = useAction(() => deployService(serviceId));
  const save = useAction(
    () =>
      compose
        ? updateService(serviceId, { compose: { ports: valid.map((p) => ({ ...p, service: p.service ?? composeServices[0] })) } })
        : updateService(serviceId, { runtime: { ports: valid } }),
    {
      result: canDeploy ? "" : "Ports saved. They are published on the next deploy.",
      onSuccess: () => {
        setPorts(valid);
        setSaved(JSON.stringify(valid));
        if (canDeploy) void deploy.run();
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
          <fieldset disabled={!canEdit} className="contents">
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

            {canEdit && available.length > 0 && (
              <div className="overflow-hidden rounded-xl border border-line">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 border-b border-line bg-surface-2/50 px-4 py-2.5">
                  <span className="text-[13px] font-medium text-fg">Detected ports</span>
                  <span className="text-xs text-muted">Click a port to publish it</span>
                </div>
                <div className="flex flex-col divide-y divide-line">
                  {available.map((g) => (
                    <div key={g.name} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:gap-4">
                      {compose && (
                        <span className="w-28 flex-none truncate text-xs font-medium text-fg-2" title={g.name}>
                          {g.name}
                        </span>
                      )}
                      <div className="flex flex-wrap gap-1.5">
                        {g.ports.map((l) => {
                          const done = mapped(g.name, l);
                          return (
                            <button
                              key={`${l.port}/${l.protocol}`}
                              type="button"
                              disabled={done}
                              onClick={() => expose(g.name, l)}
                              title={done ? "Already published" : `Publish ${l.port}/${l.protocol}`}
                              className={cn(
                                "inline-flex h-7 items-center gap-1 rounded-md border px-2 font-mono text-[12px] transition-colors",
                                done ? "cursor-default border-transparent bg-accent-soft text-accent" : "border-line bg-surface text-fg hover:border-line-strong hover:bg-hover",
                              )}
                            >
                              {done ? <Check className="size-3" /> : <Plus className="size-3 text-muted" />}
                              {l.port}
                              {l.protocol === "udp" && <span className="text-muted">/udp</span>}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
                {taken.length > 0 && (
                  <details className="group border-t border-line bg-surface-2/30 px-4 py-2.5 text-xs text-muted">
                    <summary className="flex cursor-pointer list-none items-center gap-1.5 select-none hover:text-fg-2 [&::-webkit-details-marker]:hidden">
                      <ChevronRight className="size-3.5 transition-transform group-open:rotate-90" />
                      {busyCount} {busyCount === 1 ? "port is" : "ports are"} already used on {isLocalServer ? "this machine" : serverName}; new ports skip them
                    </summary>
                    <div className="mt-2 flex flex-wrap gap-1">
                      {busy
                        .filter((p) => p > 0)
                        .map((p) => (
                          <span key={p} className="rounded bg-fg/[0.05] px-1.5 py-0.5 font-mono text-[11px] text-fg-2">
                            {p}
                          </span>
                        ))}
                    </div>
                  </details>
                )}
              </div>
            )}

            {ports.length > 0 && (
              <div
                className={cn(
                  "hidden gap-2 px-0.5 text-[11px] font-medium tracking-wide text-faint uppercase sm:grid",
                  pickService ? "grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1fr)_78px_150px_32px]" : "grid-cols-[minmax(0,1fr)_minmax(0,1fr)_78px_150px_32px]",
                )}
              >
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
                <label className="flex min-w-0 flex-col gap-1">
                  <span className="text-[11px] font-medium text-faint sm:hidden">{isLocalServer ? "Local port" : "Server port"}</span>
                  <Input
                    value={String(p.host || "")}
                    onChange={(e) => update(i, { host: digits(e.target.value) })}
                    placeholder="8080"
                    aria-label="Server port"
                    aria-invalid={busySet.has(p.host) || undefined}
                    className="h-8 font-mono"
                    inputMode="numeric"
                  />
                </label>
                <label className="flex min-w-0 flex-col gap-1">
                  <span className="text-[11px] font-medium text-faint sm:hidden">Container port</span>
                  <Input
                    value={String(p.container || "")}
                    onChange={(e) => update(i, { container: digits(e.target.value) })}
                    placeholder={String(defaultPort(p.service))}
                    aria-label="Container port"
                    className="h-8 font-mono"
                    inputMode="numeric"
                  />
                </label>
                <Button
                  variant="ghost"
                  size="icon"
                  className={cn("order-3 self-end sm:order-5", !canEdit && "invisible")}
                  onClick={() => setPorts((all) => all.filter((_, j) => j !== i))}
                  aria-label="Remove port"
                >
                  <Trash2 />
                </Button>
                <div className="order-4 sm:order-3">
                  <Select
                    size="sm"
                    value={p.protocol}
                    onValueChange={(v) => update(i, { protocol: v as PortMapping["protocol"] })}
                    options={[
                      { value: "tcp", label: "TCP" },
                      { value: "udp", label: "UDP" },
                    ]}
                  />
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
                {canEdit && (
                  <Button size="sm" onClick={add}>
                    <Plus /> Add port
                  </Button>
                )}
              </div>
            )}
            {clash && (
              <p className="text-xs text-warn">
                Port {clash.host} is already used on {isLocalServer ? "this machine" : serverName}. Try {firstFree(clash.host)}.
              </p>
            )}
            {ports.length > 0 && !clash && <p className="text-xs text-muted">One replica only: two containers cannot share a port.</p>}
          </fieldset>
        </CardBody>
        {!canEdit ? (
          <ReadOnlyFooter permission="services.manage" />
        ) : (
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
              <Button type="submit" variant="primary" size="sm" disabled={!dirty || !!clash || incomplete} loading={save.pending || deploy.pending}>
                {canDeploy ? "Save and redeploy" : "Save"}
              </Button>
            </div>
          </CardFooter>
        )}
      </form>
    </Card>
  );
}
