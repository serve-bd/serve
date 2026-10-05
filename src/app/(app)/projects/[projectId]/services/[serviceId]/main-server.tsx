"use client";

import * as React from "react";
import { Globe, Waypoints } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/misc";
import { Dialog, DialogBody, DialogClose, DialogContent, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { toast } from "@/components/ui/toast";
import { useAction } from "@/hooks/use-action";
import { cn } from "@/lib/utils";
import { type MainServerResult, setMainServer } from "@/server/actions/main-server";
import { type EntryDomain, type EntryPlan, type EntryServer, entryPlan, entryProblem } from "@/server/services/entry-plan";

/** How visitors can reach a server: its public IP, its tunnels, or nothing. */
export function entryWays(s: EntryServer) {
  const ways = [s.publicIp ? `Public IP ${s.publicIp}` : null, ...s.tunnels.map((t) => `Tunnel${t.accountName ? ` in ${t.accountName}` : ""}`)].filter(Boolean);
  return ways.length ? ways.join(" · ") : "No public IP or tunnel";
}

/** One server to pick, with whether visitors can enter through it. */
export function EntryServerOption({ server, selected, onSelect }: { server: EntryServer; selected: boolean; onSelect: () => void }) {
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
        <span className="flex items-center gap-1.5 text-xs text-muted">
          {server.tunnels.length ? <Waypoints className="size-3 text-[#f38020]" /> : <Globe className="size-3" />}
          {entryWays(server)}
          {server.proxyKind !== "none" && <span className="text-faint">· {server.proxyKind}</span>}
        </span>
      </span>
    </button>
  );
}

/** What switching to a server does to the domains, and what stops it. */
export function EntryPlanNotice({ server, plan, oldName, https }: { server: EntryServer; plan: EntryPlan; oldName: string; https?: boolean }) {
  const problem = entryProblem(server);
  if (problem) return <Notice tone="bad">{problem}</Notice>;
  if (plan.blockers.length)
    return (
      <Notice tone="bad">
        <span className="font-medium text-fg">These domains would stop working on {server.name}:</span>
        <ul className="mt-1 list-disc pl-4">
          {plan.blockers.map((b) => (
            <li key={b}>{b}</li>
          ))}
        </ul>
      </Notice>
    );
  const count = (k: string) => plan.moves.filter((m) => m.kind === k);
  const records = [...count("record"), ...count("untunnel")];
  const tunnels = count("tunnel");
  const manual = count("manual") as { hostname: string; ip: string }[];
  const renamed = count("rename");
  return (
    <Notice tone="info">
      <p>
        <span className="font-medium text-fg">{server.name} becomes the main server.</span> Its proxy takes the domains and spreads visitors over every server. {oldName} keeps
        running the app as an extra server. Nothing is redeployed.
      </p>
      <ul className="mt-1.5 list-disc pl-4">
        {records.length > 0 && (
          <li>
            Serve points {names(records)} at {server.publicIp} in Cloudflare.
          </li>
        )}
        {tunnels.length > 0 && (
          <li>
            {names(tunnels)} move to the tunnel on {server.name}.
          </li>
        )}
        {renamed.length > 0 && <li>Generated domains get the address of {server.name}.</li>}
        {server.proxyKind === "nginx" && https && <li>HTTPS certificates are copied to {server.name}.</li>}
        {manual.length > 0 && (
          <li>
            You change the DNS of {names(manual)}: point {manual.length === 1 ? "it" : "them"} at <span className="font-mono text-fg">{server.publicIp}</span>. Until then, visitors
            still reach {oldName}, which serves its own replicas only.
          </li>
        )}
      </ul>
    </Notice>
  );
}

const names = (moves: { hostname: string }[]) => moves.map((m) => m.hostname).join(", ");

function Notice({ tone, children }: { tone: "bad" | "info"; children: React.ReactNode }) {
  return (
    <div className={cn("rounded-xl border px-3.5 py-2.5 text-xs leading-relaxed text-fg-2", tone === "bad" ? "border-bad/25 bg-bad-soft" : "border-line bg-surface-2")}>
      {children}
    </div>
  );
}

/** Tell what is left for the user after a switch: DNS they manage, and anything that failed. */
export function reportMainServer(result: MainServerResult, name: string) {
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
  const { run, pending } = useAction(() => setMainServer(serviceId, chosen), {
    onSuccess: (result) => {
      reportMainServer(result, server?.name ?? "the server");
      onOpenChange(false);
    },
  });
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
              <EntryServerOption key={s.id} server={s} selected={s.id === chosen} onSelect={() => setChosen(s.id)} />
            ))}
          </div>
          {server && plan && main && <EntryPlanNotice server={server} plan={plan} oldName={main.name} https={domains.some((d) => d.https)} />}
          {server?.main && entryProblem(server) && <EntryPlanNotice server={server} plan={{ moves: [], blockers: [] }} oldName={server.name} />}
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
