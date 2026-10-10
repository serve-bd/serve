"use client";

import * as React from "react";
import Link from "next/link";
import { Check, ChevronRight, ChevronsUpDown, Search, Server, SquareTerminal } from "lucide-react";
import { Menu, MenuContent, MenuLabel, MenuLinkItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { ServiceIcon } from "@/components/service-icon";
import { Input } from "@/components/ui/input";
import { Card, EmptyState } from "@/components/ui/misc";
import { StatusDot, statusText } from "@/components/ui/status";

export type PickServer = { id: string; name: string; isLocal: boolean; username: string; status: string };
export type PickService = {
  id: string;
  name: string;
  type: string;
  icon: string | null;
  status: string;
  engine: string | null;
  projectId: string;
  projectName: string;
  environmentName: string;
  serverName: string;
};

function Row({ href, icon, name, detail, status, kind }: { href: string; icon: React.ReactNode; name: string; detail: string; status: string; kind: "service" | "server" }) {
  return (
    <Link href={href} className="group flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-hover">
      {icon}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[13px] font-medium text-fg">{name}</span>
        <span className="truncate text-xs text-muted">{detail}</span>
      </span>
      <span className="hidden flex-none items-center gap-1.5 text-xs text-muted sm:flex">
        <StatusDot status={status} kind={kind} />
        {statusText(status, kind)}
      </span>
      <ChevronRight className="size-4 flex-none text-faint group-hover:text-fg-2" />
    </Link>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-[12px] font-semibold tracking-wide text-muted uppercase">{title}</h2>
      <Card className="divide-y divide-line overflow-hidden">{children}</Card>
    </section>
  );
}

/** Every server and service a shell (or Files, with `files`) can open in, searchable by name, project or environment. */
export function TerminalPicker({ servers, services, canConsole, files }: { servers: PickServer[]; services: PickService[]; canConsole: boolean; files?: boolean }) {
  const base = files ? "/files" : "/terminal";
  const [query, setQuery] = React.useState("");
  const q = query.trim().toLowerCase();
  const hit = (...parts: string[]) => !q || parts.some((p) => p.toLowerCase().includes(q));
  const shownServers = servers.filter((s) => hit(s.name));
  const shownServices = services.filter((s) => hit(s.name, s.projectName, s.environmentName, s.serverName));
  // Grouped by project and environment, in the order the page sorted them.
  const groups = new Map<string, { title: string; items: PickService[] }>();
  for (const s of shownServices) {
    const key = `${s.projectId}:${s.environmentName}`;
    if (!groups.has(key)) groups.set(key, { title: `${s.projectName} · ${s.environmentName}`, items: [] });
    groups.get(key)!.items.push(s);
  }

  if (!servers.length && !services.length)
    return (
      <Card>
        <EmptyState
          icon={<SquareTerminal />}
          title={files ? "No files to open" : "Nothing to open a shell in"}
          description={canConsole ? "Add a service to a project first." : "Your role cannot open consoles. Ask an admin for console access."}
        />
      </Card>
    );

  return (
    <div className="flex flex-col gap-6">
      <div className="relative sm:max-w-sm">
        <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-faint" />
        <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search servers, projects and services" className="pl-9" autoFocus />
      </div>
      {shownServers.length > 0 && (
        <Group title="Servers">
          {shownServers.map((s) => (
            <Row
              key={s.id}
              href={`${base}?server=${s.id}`}
              icon={
                <span className="flex size-7 flex-none items-center justify-center rounded-lg border border-line bg-surface-2 text-muted">
                  <Server className="size-3.5" />
                </span>
              }
              name={s.name}
              detail={files ? "The server's whole disk" : `Shell as ${s.isLocal ? "root" : s.username} on the server`}
              status={s.status}
              kind="server"
            />
          ))}
        </Group>
      )}
      {[...groups.values()].map((g) => (
        <Group key={g.title} title={g.title}>
          {g.items.map((s) => (
            <Row
              key={s.id}
              href={`${base}?service=${s.id}`}
              icon={<ServiceIcon type={s.type} engine={s.engine} icon={s.icon} size="sm" />}
              name={s.name}
              detail={`${files ? "Files inside the container" : "Inside the container"} · ${s.serverName}`}
              status={s.status}
              kind="service"
            />
          ))}
        </Group>
      ))}
      {!shownServers.length && !groups.size && <p className="text-[13px] text-muted">Nothing matches “{query}”.</p>}
    </div>
  );
}

/** The open terminal's (or Files') name in the breadcrumb, opening every other server and service to switch to. */
export function TerminalSwitcher({ current, servers, services, files }: { current: string; servers: PickServer[]; services: PickService[]; files?: boolean }) {
  const base = files ? "/files" : "/terminal";
  const name = servers.find((s) => s.id === current)?.name ?? services.find((s) => s.id === current)?.name ?? "";
  const groups = new Map<string, PickService[]>();
  for (const s of services) {
    const key = `${s.projectName} · ${s.environmentName}`;
    groups.set(key, [...(groups.get(key) ?? []), s]);
  }
  const mark = (id: string, status: string, kind: "service" | "server") =>
    id === current ? <Check className="flex-none text-accent!" /> : <StatusDot status={status} kind={kind} className="flex-none" />;
  return (
    <Menu>
      <MenuTrigger className="-mx-1.5 flex min-w-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-fg-2 outline-none transition-colors hover:bg-hover hover:text-fg data-[popup-open]:bg-hover data-[popup-open]:text-fg focus-visible:ring-2 focus-visible:ring-accent/40">
        <span className="truncate">{name}</span>
        <ChevronsUpDown className="size-3.5 flex-none text-faint" />
      </MenuTrigger>
      <MenuContent align="start" className="max-h-[min(28rem,70vh)] w-72 overflow-y-auto">
        {servers.length > 0 && <MenuLabel>Servers</MenuLabel>}
        {servers.map((s) => (
          <MenuLinkItem key={s.id} render={<Link href={`${base}?server=${s.id}`} />} className="gap-2.5">
            <span className="flex size-7 flex-none items-center justify-center rounded-lg border border-line bg-surface-2 text-muted">
              <Server className="size-3.5" />
            </span>
            <span className="min-w-0 flex-1 truncate">{s.name}</span>
            {mark(s.id, s.status, "server")}
          </MenuLinkItem>
        ))}
        {[...groups].map(([title, items], i) => (
          <React.Fragment key={title}>
            {(i > 0 || servers.length > 0) && <MenuSeparator />}
            <MenuLabel>{title}</MenuLabel>
            {items.map((s) => (
              <MenuLinkItem key={s.id} render={<Link href={`${base}?service=${s.id}`} />} className="gap-2.5">
                <ServiceIcon type={s.type} engine={s.engine} icon={s.icon} size="sm" />
                <span className="min-w-0 flex-1 truncate">{s.name}</span>
                {mark(s.id, s.status, "service")}
              </MenuLinkItem>
            ))}
          </React.Fragment>
        ))}
      </MenuContent>
    </Menu>
  );
}
