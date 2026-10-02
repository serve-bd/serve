"use client";

import * as React from "react";
import { useRouter } from "@/hooks/use-router";
import { ArrowRightLeft, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardHeader } from "@/components/ui/misc";
import { useConfirm } from "@/components/ui/confirm";
import { LogViewer } from "@/components/log-viewer";
import { useAction } from "@/hooks/use-action";
import { getProxySwitch, setProxyKind } from "@/server/actions/proxy-kind";
import { proxyLabels, type ProxyKind, type ProxySwitchState } from "@/server/proxy/config";
import { cn } from "@/lib/utils";

const OPTIONS: { kind: ProxyKind; name: string; tagline: string; points: string[] }[] = [
  { kind: "nginx", name: "nginx", tagline: "Fast and predictable", points: ["Certificates issued and renewed for you", "Raw nginx directives per service"] },
  { kind: "caddy", name: "Caddy", tagline: "Automatic HTTPS", points: ["Caddy gets and renews certificates itself", "Simple Caddyfile snippets, HTTP/3"] },
  { kind: "traefik", name: "Traefik", tagline: "Dynamic configuration", points: ["Built-in ACME, including Cloudflare DNS", "Middlewares, metrics and a dashboard"] },
  { kind: "none", name: "None", tagline: "No proxy", points: ["No proxy runs on this server", "Use published ports or your own proxy"] },
];

export function ProxyPicker({
  serverId,
  kind,
  switchState,
  stopped,
  onLiveChange,
}: {
  serverId: string;
  kind: ProxyKind;
  switchState: ProxySwitchState | null;
  stopped: boolean;
  onLiveChange?: (state: ProxySwitchState | null) => void;
}) {
  const router = useRouter();
  const confirm = useConfirm();
  const [live, setLiveState] = React.useState<ProxySwitchState | null>(switchState);
  const setLive = React.useCallback(
    (state: ProxySwitchState | null) => {
      setLiveState(state);
      onLiveChange?.(state);
    },
    [onLiveChange],
  );
  const running = live?.state === "running";
  const change = useAction((to: ProxyKind) => setProxyKind(serverId, to));

  // While a switch runs, follow its log.
  React.useEffect(() => {
    if (!running) return;
    const timer = setInterval(async () => {
      const res = await getProxySwitch(serverId);
      if (!res.ok) return;
      setLive(res.data.switch);
      if (res.data.switch?.state !== "running") router.refresh();
    }, 1500);
    return () => clearInterval(timer);
  }, [running, serverId, router, setLive]);

  const pick = async (to: ProxyKind) => {
    const target = OPTIONS.find((o) => o.kind === to)!;
    const ok = await confirm({
      title: to === "none" ? "Remove the proxy?" : `Switch to ${target.name}?`,
      description:
        to === "none"
          ? "The proxy container is removed from this server. Every domain stops answering; services stay reachable only on their published ports. Certificates are no longer requested."
          : stopped
            ? `The ${target.name} configuration is written for every site. The proxy stays stopped until you start it.`
            : `The ${target.name} configuration is written for every site, then the proxy container is replaced. Every site on this server is unreachable for a few seconds. If ${target.name} does not start, the current proxy comes back.`,
      confirmLabel: to === "none" ? "Remove the proxy" : `Switch to ${target.name}`,
      danger: to === "none",
    });
    if (!ok) return;
    const res = await change.run(to);
    if (res !== undefined) setLive({ state: "running", from: kind, to, startedAt: new Date().toISOString(), log: "Queued\n" });
  };

  return (
    <Card>
      <CardHeader title="Reverse proxy" description="The program that receives every request for this server's domains. Switch any time; settings for each proxy are kept." />
      <div className={cn("grid grid-cols-1 gap-3 p-5 sm:grid-cols-3", kind === "none" && "xl:grid-cols-4")}>
        {/* No "none" choice: to run without a proxy, stop it. Only a server still set to none shows it. */}
        {OPTIONS.filter((o) => o.kind !== "none" || kind === "none").map((o) => {
          const active = o.kind === kind;
          const target = running && live?.to === o.kind;
          return (
            <div key={o.kind} className={cn("flex flex-col gap-3 rounded-xl border p-4 transition-colors", active ? "border-accent bg-accent-soft/30" : "border-line")}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-[14px] font-semibold text-fg">{o.name}</p>
                  <p className="text-xs text-muted">{o.tagline}</p>
                </div>
                {active && (
                  <Badge tone="accent">
                    <Check /> In use
                  </Badge>
                )}
              </div>
              <ul className="flex flex-1 flex-col gap-1 text-[12.5px] text-fg-2">
                {o.points.map((p) => (
                  <li key={p} className="flex gap-1.5">
                    <span className="mt-1.5 size-1 flex-none rounded-full bg-muted" />
                    {p}
                  </li>
                ))}
              </ul>
              {!active && (
                <Button size="sm" onClick={() => pick(o.kind)} disabled={running} loading={target}>
                  {!target && <ArrowRightLeft />} {target ? "Switching…" : o.kind === "none" ? "Use no proxy" : `Switch to ${o.name}`}
                </Button>
              )}
            </div>
          );
        })}
      </div>
      {live && (live.state !== "success" || running) && (
        <div className="border-t border-line p-5 pt-4">
          <p className={cn("mb-2 text-[13px] font-medium", live.state === "failed" ? "text-bad" : "text-fg")}>
            {live.state === "running" ? `Switching to ${proxyLabels[live.to]}…` : `Switch to ${proxyLabels[live.to]} failed${live.error ? `: ${live.error}` : ""}`}
          </p>
          <LogViewer
            lines={live.log
              .trim()
              .split("\n")
              .map((text) => ({ text }))}
            height="220px"
            filename="proxy-switch.log"
          />
        </div>
      )}
    </Card>
  );
}
