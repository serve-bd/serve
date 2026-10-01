import Link from "next/link";
import { AlertTriangle, ArrowRight, ArrowUpRight, Blocks, Plus, Rocket } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardBody, CardHeader, EmptyState } from "@/components/ui/misc";
import { StatusDot, statusText } from "@/components/ui/status";
import { serverReachable } from "@/lib/server-services";
import { cn } from "@/lib/utils";
import { type Widget, widgetLimit, widgetTitle } from "@/lib/dashboard";
import type { DeployBucket } from "@/server/dashboard";
import { DeployTimeline, type DeploymentTableRow } from "./deploy-timeline";
import type { ProjectSummary } from "./project-card";
import { ProjectRow, ROW_PAD, type ServerCardData, ServerRow } from "./racks";
import { ActivityCalendar, Greeting, ServerUsage } from "./widgets-client";

export type DashboardData = {
  userName: string;
  canCreate: boolean;
  projects: ProjectSummary[];
  servers: ServerCardData[];
  deployments: DeploymentTableRow[];
  buckets: DeployBucket[];
};

const BROKEN = new Set(["failed", "crashed"]);

/**
 * A widget's frame: a card with a title bar, or no card and a small title on the page.
 * `flush` content (lists) runs edge to edge in a card.
 */
function Frame({
  widget,
  title,
  action,
  flush,
  bare,
  children,
}: {
  widget: Widget;
  title?: string;
  action?: React.ReactNode;
  flush?: boolean;
  bare?: boolean;
  children: React.ReactNode;
}) {
  const heading = title ?? widgetTitle(widget);
  if (widget.frame === "plain") {
    return (
      <section data-frame="plain" className={cn("group/frame flex min-w-0 flex-col gap-2", widget.fill && "h-full")}>
        {!bare && (
          <h2 className="flex min-h-7 items-center justify-between gap-2 text-[13px] font-medium text-muted">
            <span className="truncate">{heading}</span>
            {action}
          </h2>
        )}
        <div className={cn("min-w-0", flush && "divide-y divide-line", widget.fill && "flex-1")}>{children}</div>
      </section>
    );
  }
  return (
    <Card data-frame="card" className={cn("group/frame flex min-w-0 flex-col", widget.fill && "h-full")}>
      {!bare && <CardHeader className="flex-nowrap items-center" title={<span className="truncate">{heading}</span>} actions={action} />}
      {flush ? <div className={cn("divide-y divide-line", widget.fill && "flex-1")}>{children}</div> : <CardBody className={cn(widget.fill && "flex-1")}>{children}</CardBody>}
    </Card>
  );
}

function ViewAll({ href, more }: { href: string; more: number }) {
  return (
    <Link href={href} className={cn(buttonVariants({ variant: "ghost", size: "xs" }), "flex-none")}>
      {more > 0 ? `${more} more` : "View all"} <ArrowRight />
    </Link>
  );
}

function Hint({ children }: { children: React.ReactNode }) {
  return <p className="py-2 text-[13px] text-muted">{children}</p>;
}

function Glance({ data }: { data: DashboardData }) {
  const services = data.projects.flatMap((p) => p.services);
  const running = services.filter((s) => s.status === "running").length;
  const online = data.servers.filter(serverReachable).length;
  const now = Date.now();
  const since = (days: number) => data.buckets.filter((b) => b.t >= now - days * 86_400_000);
  const sum = (list: DeployBucket[], key: "n" | "failed") => list.reduce((a, b) => a + b[key], 0);
  const week = sum(since(7), "n");
  const month = since(30);
  const monthTotal = sum(month, "n");
  const success = monthTotal ? Math.round(((monthTotal - sum(month, "failed")) / monthTotal) * 100) : null;
  const tiles: [string, React.ReactNode, string][] = [
    [
      "Services",
      <>
        {running}
        <span className="text-faint">/{services.length}</span>
      </>,
      "running",
    ],
    ["Projects", data.projects.length, data.projects.length === 1 ? "project" : "projects"],
    [
      "Servers",
      <>
        {online}
        <span className="text-faint">/{data.servers.length}</span>
      </>,
      "online",
    ],
    ["Deploys", week, "in the last 7 days"],
    ["Success", success === null ? "–" : `${success}%`, "of deploys in 30 days"],
  ];
  return (
    <dl className="grid grid-cols-[repeat(auto-fit,minmax(6.5rem,1fr))] gap-x-6 gap-y-5">
      {tiles.map(([label, value, note]) => (
        <div key={label} className="flex min-w-0 flex-col gap-1">
          <dt className="text-[11px] font-medium tracking-wide text-faint uppercase">{label}</dt>
          <dd className="font-display text-[26px] leading-none font-semibold text-fg tabular-nums">{value}</dd>
          <dd className="truncate text-xs text-muted">{note}</dd>
        </div>
      ))}
    </dl>
  );
}

function Attention({ widget, data }: { widget: Widget; data: DashboardData }) {
  const items = [
    ...data.projects.flatMap((p) => p.services.filter((s) => BROKEN.has(s.status)).map((s) => ({ kind: "service" as const, s, p }))),
    ...data.servers.filter((s) => !serverReachable(s)).map((s) => ({ kind: "server" as const, s })),
  ];
  if (!items.length) return null;
  const shown = items.slice(0, widgetLimit(widget));
  return (
    <Frame
      widget={widget}
      flush
      title={widget.title?.trim() || undefined}
      action={items.length > shown.length && <span className="flex-none text-xs text-muted">{items.length - shown.length} more</span>}
    >
      {shown.map((item) =>
        item.kind === "service" ? (
          <Link key={item.s.id} href={`/projects/${item.p.id}/services/${item.s.id}`} className={cn("flex items-center gap-3 py-3 transition-colors hover:bg-hover/60", ROW_PAD)}>
            <AlertTriangle className="size-4 flex-none text-bad" />
            <span className="min-w-0 flex-1 truncate text-[13.5px] text-fg">
              <span className="font-medium">{item.s.name}</span> <span className="text-muted">in {item.p.name}</span>
            </span>
            <span className="flex-none text-xs text-muted">{statusText(item.s.status)}</span>
          </Link>
        ) : (
          <Link key={item.s.id} href={`/servers/${item.s.id}`} className={cn("flex items-center gap-3 py-3 transition-colors hover:bg-hover/60", ROW_PAD)}>
            <AlertTriangle className="size-4 flex-none text-bad" />
            <span className="min-w-0 flex-1 truncate text-[13.5px] text-fg">
              <span className="font-medium">{item.s.name}</span> <span className="text-muted">server</span>
            </span>
            <span className="flex-none text-xs text-muted">{statusText(item.s.status, "server")}</span>
          </Link>
        ),
      )}
    </Frame>
  );
}

function NewProjectButton({ show }: { show: boolean }) {
  return (
    <Link href="/projects/new" className={buttonVariants({ variant: "primary", size: "sm" })} hidden={!show}>
      <Plus /> New project
    </Link>
  );
}

/** The widget's content in its frame, or null when it has nothing to show (it then stays hidden). */
export function renderWidget(widget: Widget, data: DashboardData): React.ReactNode {
  const limit = widgetLimit(widget);
  switch (widget.type) {
    case "greeting":
      return (
        <Frame widget={widget} bare>
          <Greeting name={data.userName} plain={widget.frame === "plain"} />
        </Frame>
      );
    case "glance":
      return (
        <Frame widget={widget}>
          <Glance data={data} />
        </Frame>
      );
    case "attention":
      return <Attention widget={widget} data={data} />;
    case "deploys": {
      const rows = data.deployments.slice(0, limit);
      return (
        <Frame widget={widget} flush={!rows.length}>
          {rows.length ? (
            <DeployTimeline rows={rows} />
          ) : (
            <EmptyState icon={<Rocket />} title="No deployments yet" description="Deployments show up here as soon as you ship something." />
          )}
        </Frame>
      );
    }
    case "activity":
      return (
        <Frame widget={widget}>
          <ActivityCalendar buckets={data.buckets} weeks={widget.options.weeks ?? 26} />
        </Frame>
      );
    case "projects": {
      const shown = data.projects.slice(0, limit);
      return (
        <Frame widget={widget} flush action={shown.length > 0 && <ViewAll href="/projects" more={data.projects.length - shown.length} />}>
          {shown.length ? (
            shown.map((p) => <ProjectRow key={p.id} project={p} />)
          ) : (
            <EmptyState
              icon={<Blocks />}
              title="Create your first project"
              description="Projects group apps, databases and services that work together."
              action={<NewProjectButton show={data.canCreate} />}
            />
          )}
        </Frame>
      );
    }
    case "project": {
      const project = data.projects.find((p) => p.id === widget.options.projectId);
      if (!project) {
        return (
          <Frame widget={widget}>
            <Hint>
              {widget.options.projectId ? "This project is gone, or you cannot open it. Pick another one in the widget's settings." : "Pick a project in the widget's settings."}
            </Hint>
          </Frame>
        );
      }
      const shown = project.services.slice(0, limit);
      return (
        <Frame
          widget={widget}
          title={widget.title?.trim() || project.name}
          flush={shown.length > 0}
          action={<ViewAll href={`/projects/${project.id}`} more={project.services.length - shown.length} />}
        >
          {shown.length ? (
            shown.map((s) => (
              <Link key={s.id} href={`/projects/${project.id}/services/${s.id}`} className={cn("flex items-center gap-3 py-3 transition-colors hover:bg-hover/60", ROW_PAD)}>
                <StatusDot status={s.status} />
                <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium text-fg">{s.name}</span>
                <span className="flex-none text-xs text-muted">{statusText(s.status)}</span>
              </Link>
            ))
          ) : (
            <Hint>This project has no services yet.</Hint>
          )}
        </Frame>
      );
    }
    case "servers": {
      const shown = data.servers.slice(0, limit);
      return (
        <Frame widget={widget} flush={shown.length > 0} action={shown.length > 0 && <ViewAll href="/servers" more={data.servers.length - shown.length} />}>
          {shown.length ? shown.map((s) => <ServerRow key={s.id} server={s} />) : <Hint>No servers to show.</Hint>}
        </Frame>
      );
    }
    case "server": {
      const server = data.servers.find((s) => s.id === widget.options.serverId) ?? (widget.options.serverId ? undefined : data.servers[0]);
      if (!server) {
        return (
          <Frame widget={widget}>
            <Hint>This server is gone, or you cannot see it. Pick another one in the widget's settings.</Hint>
          </Frame>
        );
      }
      return (
        <Frame widget={widget} title={widget.title?.trim() || server.name} action={<ViewAll href={`/servers/${server.id}`} more={0} />}>
          {!serverReachable(server) ? (
            <Hint>{statusText(server.status, "server")}. Usage shows again when Serve reaches it.</Hint>
          ) : !server.metricsEnabled ? (
            <Hint>Metrics are off for this server.</Hint>
          ) : (
            <ServerUsage series={server.series} />
          )}
        </Frame>
      );
    }
    case "shortcuts": {
      const links = widget.options.links ?? [];
      return (
        <Frame widget={widget}>
          {links.length ? (
            <ul className="grid grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] gap-2">
              {links.map((l, i) => {
                const external = !l.href.startsWith("/");
                const inner = (
                  <>
                    <span className="flex size-7 flex-none items-center justify-center rounded-lg bg-sunken font-display text-[13px] font-semibold text-fg-2 uppercase">
                      {l.label.slice(0, 1)}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-fg">{l.label}</span>
                    {external && <ArrowUpRight className="size-3.5 flex-none text-faint" />}
                  </>
                );
                const cls = "flex items-center gap-2.5 rounded-xl border border-line bg-surface px-2.5 py-2 transition-colors hover:border-line-strong hover:bg-hover/60";
                return (
                  <li key={i}>
                    {external ? (
                      <a href={l.href} target="_blank" rel="noopener noreferrer" className={cls}>
                        {inner}
                      </a>
                    ) : (
                      <Link href={l.href} className={cls}>
                        {inner}
                      </Link>
                    )}
                  </li>
                );
              })}
            </ul>
          ) : (
            <Hint>Add links in the widget's settings.</Hint>
          )}
        </Frame>
      );
    }
    case "note": {
      const text = widget.options.text?.trim();
      if (!text) return null;
      return (
        <Frame widget={widget}>
          <p className="text-[13.5px] leading-relaxed whitespace-pre-wrap text-fg-2 [overflow-wrap:anywhere]">{text}</p>
        </Frame>
      );
    }
  }
}
