"use client";

import * as React from "react";
import { mutate } from "swr";
import { Globe, Waypoints } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/misc";
import { Dialog, DialogBody, DialogClose, DialogContent, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { toast } from "@/components/ui/toast";
import { useAction } from "@/hooks/use-action";
import { cn } from "@/lib/utils";
import { type MainServerResult, setMainServer } from "@/server/actions/main-server";
import { type EntryDomain, type EntryPlan, type EntryServer, entryPlan, entryProblem } from "@/server/services/entry-plan";

/**
 * How visitors can reach a server: its public IP, its tunnels, or nothing. With the app's domains:
 * the public IP only when a domain would use it (all of them going through tunnels need none).
 */
export function entryWays(s: EntryServer, domains?: EntryDomain[]) {
  const viaTunnels = !!domains?.length && s.tunnels.length > 0 && domains.every((d) => d.tunnelId || d.wantsTunnel || d.sharedTunnel);
  const ways = [s.publicIp && !viaTunnels ? `Public IP ${s.publicIp}` : null, ...s.tunnels.map((t) => `Tunnel${t.accountName ? ` in ${t.accountName}` : ""}`)].filter(Boolean);
  return ways.length ? ways.join(" · ") : "No public IP or tunnel";
}

/** One server to pick, with whether visitors can enter through it. */
export function EntryServerOption({ server, selected, onSelect, domains }: { server: EntryServer; selected: boolean; onSelect: () => void; domains?: EntryDomain[] }) {
  const problem = entryProblem(server);
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={cn(
        "flex items-start gap-3 rounded-xl border p-3 text-left transition-colors",
        selected ? "border-accent bg-accent-soft/40 ring-1 ring-accent/30" : "border-line bg-surface hover:border-line-strong",
      )}
    >
      <span className={cn("mt-0.5 flex size-4 flex-none items-center justify-center rounded-full border", selected ? "border-accent" : "border-line-strong")}>
        {selected && <span className="size-2 rounded-full bg-accent" />}
      </span>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="flex flex-wrap items-center gap-1.5 text-[13px] font-medium text-fg">
          {server.name}
          {server.main && <Badge tone="info">Main now</Badge>}
          {problem && <Badge tone="bad">Can&apos;t take visitors</Badge>}
        </span>
        <span className="flex items-start gap-1.5 text-xs text-muted">
          {server.tunnels.length ? <Waypoints className="mt-0.5 size-3 flex-none text-[#f38020]" /> : <Globe className="mt-0.5 size-3 flex-none" />}
          {/* One run of text, so a long line wraps under itself with the proxy at its end. */}
          <span className="min-w-0">
            {entryWays(server, domains)}
            {server.proxyKind !== "none" && <span className="text-faint"> · {server.proxyKind}</span>}
          </span>
        </span>
      </span>
    </button>
  );
}

/** Why visitors cannot enter through a server, or which domains would stop working there. Nothing when it can take over. */
export function EntryPlanNotice({ server, plan }: { server: EntryServer; plan: EntryPlan }) {
  const problem = entryProblem(server);
  if (problem) return <Notice>{problem}</Notice>;
  if (!plan.blockers.length) return null;
  return (
    <Notice>
      <span className="font-medium text-fg">These domains would stop working on {server.name}:</span>
      <ul className="mt-1 list-disc pl-4">
        {plan.blockers.map((b) => (
          <li key={b}>{b}</li>
        ))}
      </ul>
    </Notice>
  );
}

function Notice({ children, tone = "bad" }: { children: React.ReactNode; tone?: "bad" | "warn" }) {
  return (
    <div className={cn("rounded-xl border px-3.5 py-2.5 text-xs leading-relaxed text-fg-2", tone === "warn" ? "border-warn/25 bg-warn-soft" : "border-bad/25 bg-bad-soft")}>
      {children}
    </div>
  );
}

/** Load balancing from this server cannot reach some of the app's servers: the switch goes ahead, they just get no visitors. */
export function ApartNotice({ server, servers }: { server: EntryServer; servers: EntryServer[] }) {
  const names = (server.apartFrom ?? []).map((id) => servers.find((s) => s.id === id)?.name).filter((n): n is string => !!n);
  if (!names.length) return null;
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  return (
    <Notice tone="warn">
      {server.name} shares no private network with {list}, so every visitor will go to the replicas on {server.name}. Put them in the same private network to share the visitors
      again.
    </Notice>
  );
}

/** Tell what is left for the user after a switch: DNS they manage, and anything that failed. */
export function reportMainServer(result: MainServerResult, name: string) {
  // The DNS checks compare with the main server's IP: check again against the new one.
  void mutate((key) => Array.isArray(key) && key[0] === "dns");
  if (result.manual.length) {
    const byIp = new Map<string, string[]>();
    for (const m of result.manual) byIp.set(m.ip, [...(byIp.get(m.ip) ?? []), m.hostname]);
    toast.warning(
      `Visitors now enter through ${name}`,
      [...byIp].map(([ip, hosts]) => `Point ${hosts.join(", ")} at ${ip} in your DNS.`).join(" ") + (result.warnings.length ? ` ${result.warnings.join(" ")}` : ""),
      // Steps left for the user: long enough to read and copy.
      20_000,
    );
  } else if (result.warnings.length) toast.warning(`Visitors now enter through ${name}`, result.warnings.join(" "), 20_000);
}

/** Pick the server visitors enter through. */
export function MainServerDialog({
  serviceId,
  servers,
  domains,
  open,
  onOpenChange,
  initial,
}: {
  serviceId: string;
  servers: EntryServer[];
  domains: EntryDomain[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The server to start on (a "Make main server" button), else the main one. */
  initial?: string;
}) {
  const main = servers.find((s) => s.main);
  const [chosen, setChosen] = React.useState(initial ?? main?.id ?? "");
  React.useEffect(() => {
    if (open) setChosen(initial ?? main?.id ?? "");
  }, [open, initial, main?.id]);
  const server = servers.find((s) => s.id === chosen);
  const plan = server && !server.main ? entryPlan(server, domains) : null;
  const ok = !!server && !server.main && !entryProblem(server) && !plan?.blockers.length;
  // Closed once the page shows the new main server, not before: the refresh takes a few seconds,
  // and a closed dialog over the old values looks like the switch did nothing.
  const [switched, setSwitched] = React.useState(false);
  const { run, pending } = useAction(() => setMainServer(serviceId, chosen), {
    onSuccess: (result) => {
      reportMainServer(result, server?.name ?? "the server");
      setSwitched(true);
    },
  });
  React.useEffect(() => {
    if (switched && !pending) {
      setSwitched(false);
      onOpenChange(false);
    }
  }, [switched, pending, onOpenChange]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader
          title="Main server"
          description="Visitors enter through the main server. Its proxy holds the domains and certificates, and spreads visitors over the replicas on every server."
        />
        <DialogBody>
          <div className="flex flex-col gap-2" role="radiogroup" aria-label="Main server">
            {servers.map((s) => (
              <EntryServerOption key={s.id} server={s} selected={s.id === chosen} onSelect={() => setChosen(s.id)} domains={domains} />
            ))}
          </div>
          {server && plan && <EntryPlanNotice server={server} plan={plan} />}
          {server && !server.main && ok && <ApartNotice server={server} servers={servers} />}
          {server?.main && entryProblem(server) && <EntryPlanNotice server={server} plan={{ moves: [], blockers: [] }} />}
        </DialogBody>
        <DialogFooter>
          <DialogClose render={<Button variant="ghost" size="sm" />}>Cancel</DialogClose>
          <Button variant="primary" size="sm" disabled={!ok} loading={pending} onClick={() => run()}>
            Make main server
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
