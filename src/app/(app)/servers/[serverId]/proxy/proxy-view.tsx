"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Check, Info, Loader2, Play, Power, RefreshCw, RotateCw, Square, TriangleAlert, Unplug, Wrench } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardFooter, CardHeader, EmptyState, TimeAgo } from "@/components/ui/misc";
import { Led } from "@/components/ui/status";
import { Textarea } from "@/components/ui/input";
import { useConfirm } from "@/components/ui/confirm";
import { LogViewer, type LogLine } from "@/components/log-viewer";
import { useAction } from "@/hooks/use-action";
import { toast } from "@/components/ui/toast";
import { getProxyLogs, rebuildProxyNow, reloadProxyNow, restartProxyNow, saveProxyCustomConfig, startProxyNow, stopProxyNow } from "@/server/actions/server-proxy";
import { proxyLabels, type CaddySettings, type NginxSettings, type ProxyDefaults, type ProxyFile, type ProxyKind, type ProxySwitchState } from "@/server/proxy/config";
import { ProxyPicker } from "./proxy-picker";
import { CaddySettingsCard, NginxSettingsCard, TraefikSettingsCard, type TraefikSettingsView } from "./proxy-settings";
import { BuiltInDefaultsCard, DynamicConfigsCard, ProxyContainerCard, type ContainerView, type ManagedFile } from "./dynamic-configs";
import { cn } from "@/lib/utils";

/** A switch counts as running only for a while, so a crashed worker does not lock the page. */
const isSwitching = (s: ProxySwitchState | null) => s?.state === "running" && Date.now() - new Date(s.startedAt).getTime() < 10 * 60_000;

export function ProxyView({
  serverId,
  status,
  test,
  customConfig,
  maxBodySize,
  files,
  kind,
  stopped,
  switchState,
  settings,
  acmeEmail,
  cloudflareAccounts,
  customFiles,
  defaults,
  container,
  defaultImage,
  definition,
}: {
  serverId: string;
  status: { running: boolean; exists: boolean; image: string; kind: ProxyKind | null; startedAt: string | null; container: string; ports: { http: number; https: number } };
  test: { ok: boolean; output: string; state: "ok" | "failed" | "unavailable" };
  customConfig: string;
  maxBodySize: string;
  files: ManagedFile[];
  customFiles: ProxyFile[];
  defaults: Required<ProxyDefaults>;
  container: ContainerView;
  defaultImage: string;
  definition: string | null;
  kind: ProxyKind;
  stopped: boolean;
  switchState: ProxySwitchState | null;
  settings: { nginx: NginxSettings; caddy: CaddySettings; traefik: TraefikSettingsView };
  acmeEmail: string | null;
  cloudflareAccounts: { id: string; name: string }[];
}) {
  const confirm = useConfirm();
  const [live, setLive] = React.useState<ProxySwitchState | null>(switchState);
  const switching = isSwitching(live);
  // The title follows the container that actually runs (it lags behind while a switch is in progress).
  const shown: ProxyKind = status.kind ?? kind;
  const label = proxyLabels[shown];
  const busy = switching || stopped;
  const reload = useAction(() => reloadProxyNow(serverId), { success: "Proxy reloaded" });
  const restart = useAction(() => restartProxyNow(serverId), { success: "Proxy restarted" });
  const rebuild = useAction(() => rebuildProxyNow(serverId), { success: "Rebuilding proxy configuration" });
  const stop = useAction(() => stopProxyNow(serverId), { success: "Proxy stopped" });
  const start = useAction(() => startProxyNow(serverId), { success: "Proxy started" });

  return (
    <>
      <ProxyPicker serverId={serverId} kind={kind} switchState={switchState} stopped={stopped} onLiveChange={setLive} />
      {kind === "none" && !switching && (
        <Card>
          <EmptyState
            icon={<Unplug />}
            title="No proxy on this server"
            description="Serve does not run a reverse proxy here, so domains and certificates are not served. Reach services on their published ports or put your own proxy in front."
          />
        </Card>
      )}
      {kind !== "none" && !switching && stopped && (
        <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-warn/25 bg-warn-soft px-5 py-4">
          <Square className="size-4 flex-none text-warn" />
          <p className="min-w-0 flex-1 text-[13px] text-fg-2">
            <span className="font-medium text-fg">The proxy is stopped.</span> Every site on this server is offline. Serve does not start it again on its own.
          </p>
          <Button size="sm" variant="primary" onClick={() => start.run()} loading={start.pending}>
            <Play /> Start proxy
          </Button>
        </div>
      )}
      {(kind !== "none" || switching) && (
        <Card>
          <CardHeader
            title={switching && live ? `Switching to ${proxyLabels[live.to]}…` : `${label} proxy`}
            description={
              switching
                ? "Serve is replacing the proxy container. Actions are available again when the switch ends."
                : "Routes every domain on this server to its app and serves TLS."
            }
            actions={
              <div className="flex flex-wrap gap-2">
                <Button size="sm" onClick={() => reload.run()} loading={reload.pending} disabled={!status.running || switching}>
                  <RefreshCw /> Reload
                </Button>
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={async () => {
                    if (
                      await confirm({
                        title: "Restart the proxy?",
                        description: `Every site is unreachable for a few seconds while ${label} restarts. Reload is usually enough.`,
                        confirmLabel: "Restart",
                      })
                    )
                      restart.run();
                  }}
                  loading={restart.pending}
                >
                  <Power /> Restart
                </Button>
                {!stopped && (
                  <Button
                    size="sm"
                    variant="danger-ghost"
                    disabled={switching}
                    onClick={async () => {
                      if (
                        await confirm({
                          title: "Stop the proxy?",
                          description: "Every site on this server goes offline until you start the proxy again. Serve will not restart it on its own.",
                          confirmLabel: "Stop proxy",
                          danger: true,
                        })
                      )
                        stop.run();
                    }}
                    loading={stop.pending}
                  >
                    <Square /> Stop
                  </Button>
                )}
              </div>
            }
          />
          {switching ? (
            <div className="flex items-center gap-2.5 px-5 py-4 text-[13px] text-fg-2">
              <Loader2 className="size-4 flex-none animate-spin text-muted" />
              Follow the progress in the log above. Sites on this server are unreachable for a few seconds.
            </div>
          ) : (
            <>
              <dl className="grid grid-cols-1 divide-y divide-line sm:grid-cols-2 sm:divide-y-0">
                <div className="flex min-w-0 flex-col divide-y divide-line">
                  <Row label="Status">
                    <span className="flex items-center gap-2">
                      <Led color={status.running ? "var(--ok)" : "var(--bad)"} />
                      {status.running ? (
                        <>
                          Running
                          {status.startedAt && (
                            <span className="text-muted">
                              · <TimeAgo date={status.startedAt} />
                            </span>
                          )}
                        </>
                      ) : stopped ? (
                        "Stopped by an admin"
                      ) : status.exists ? (
                        "Stopped"
                      ) : (
                        "Not created"
                      )}
                    </span>
                  </Row>
                  <Row label="Container">
                    <code className="truncate font-mono text-xs">{status.container}</code>
                  </Row>
                  <Row label="Image">
                    <code className="truncate font-mono text-xs">{status.image}</code>
                  </Row>
                </div>
                <div className="flex min-w-0 flex-col divide-y divide-line sm:border-l sm:border-line">
                  <Row label="Ports">
                    <span className="tabular-nums">
                      HTTP {status.ports.http} · HTTPS {status.ports.https}
                    </span>
                  </Row>
                  <Row label="Sites">{files.filter((f) => f.kind === "service" || f.kind === "dashboard").length}</Row>
                  <Row label="Max upload">
                    <code className="font-mono text-xs">{kind === "nginx" ? settings.nginx.maxBodySize || maxBodySize : "Per service"}</code>
                  </Row>
                </div>
              </dl>
              <div className={cn("flex items-start gap-2.5 border-t border-line px-5 py-3 text-[13px]", test.state === "failed" ? "bg-bad-soft/50" : "text-fg-2")}>
                {test.state === "ok" ? (
                  <Check className="mt-0.5 size-4 flex-none text-ok" />
                ) : test.state === "failed" ? (
                  <TriangleAlert className="mt-0.5 size-4 flex-none text-bad" />
                ) : (
                  <Info className="mt-0.5 size-4 flex-none text-muted" />
                )}
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className={test.state === "failed" ? "font-medium text-fg" : undefined}>
                    {test.state === "ok"
                      ? "Configuration test passed"
                      : test.state === "failed"
                        ? "Configuration test failed"
                        : `Configuration not tested: ${test.output.replace(/\.$/, "").toLowerCase()}`}
                  </span>
                  {test.state === "failed" && <pre className="overflow-x-auto font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap text-muted">{test.output}</pre>}
                </div>
                <Button size="xs" variant="ghost" onClick={() => rebuild.run()} loading={rebuild.pending} className="flex-none">
                  <Wrench /> Rebuild configs
                </Button>
              </div>
            </>
          )}
        </Card>
      )}

      {kind !== "none" && !switching && (
        <>
          {kind === "nginx" && <NginxSettingsCard serverId={serverId} initial={settings.nginx} defaultBodySize={maxBodySize} />}
          {kind === "caddy" && <CaddySettingsCard serverId={serverId} initial={settings.caddy} acmeEmail={acmeEmail} />}
          {kind === "traefik" && <TraefikSettingsCard serverId={serverId} initial={settings.traefik} cloudflareAccounts={cloudflareAccounts} />}
          <DynamicConfigsCard serverId={serverId} kind={kind} managed={files} custom={customFiles} disabled={switching} running={status.running} />
          <BuiltInDefaultsCard key={JSON.stringify(defaults)} serverId={serverId} kind={kind} initial={defaults} disabled={switching} />
          {kind === "nginx" && <CustomConfigCard initial={customConfig} />}
          <ProxyContainerCard
            key={JSON.stringify(container)}
            serverId={serverId}
            kind={kind}
            initial={container}
            defaultImage={defaultImage}
            definition={definition}
            disabled={switching}
          />
          <ProxyLogs serverId={serverId} />
        </>
      )}
    </>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 px-5 py-2.5 text-[13px]">
      <dt className="flex-none text-muted">{label}</dt>
      <dd className="flex min-w-0 justify-end text-right text-fg-2">{children}</dd>
    </div>
  );
}

function CustomConfigCard({ initial }: { initial: string }) {
  const [value, setValue] = React.useState(initial);
  const [saved, setSaved] = React.useState(initial);
  const [error, setError] = React.useState<string | null>(null);
  const dirty = value !== saved;
  const router = useRouter();
  const [pending, setPending] = React.useState(false);

  return (
    <Card>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setError(null);
          setPending(true);
          const res = await saveProxyCustomConfig(value);
          setPending(false);
          if (!res.ok) {
            // nginx errors are long: show them inline instead of a toast.
            setError(res.error);
            return;
          }
          setSaved(value);
          toast.success("Custom configuration applied");
          router.refresh();
        }}
      >
        <CardHeader
          title="Shared nginx directives"
          description={
            <>
              Extra directives for nginx&apos;s <code className="font-mono text-[12px]">http</code> block, like timeouts, headers or rate limit zones. Serve tests them with{" "}
              <code className="font-mono text-[12px]">nginx -t</code> before applying. They apply to every server that runs nginx.
            </>
          }
        />
        <CardBody className="flex flex-col gap-3 py-5">
          <Textarea
            value={value}
            onChange={(e) => setValue(e.target.value)}
            rows={8}
            spellCheck={false}
            placeholder={"# Example\nproxy_read_timeout 600s;\nlimit_req_zone $binary_remote_addr zone=api:10m rate=10r/s;"}
            className="font-mono text-[12.5px] leading-relaxed"
          />
          {error && (
            <div className="flex items-start gap-2.5 rounded-xl border border-bad/15 bg-bad-soft/60 px-3.5 py-3">
              <TriangleAlert className="mt-0.5 size-4 flex-none text-bad" />
              <pre className="min-w-0 flex-1 font-mono text-[11.5px] leading-relaxed break-words whitespace-pre-wrap text-fg-2">{error}</pre>
            </div>
          )}
        </CardBody>
        <CardFooter>
          <span className="truncate text-xs text-muted">{dirty ? "Unsaved changes" : saved.trim() ? "Applied" : "No custom directives"}</span>
          <div className="flex flex-none gap-2">
            {dirty && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  setValue(saved);
                  setError(null);
                }}
              >
                Discard
              </Button>
            )}
            <Button type="submit" size="sm" variant="primary" disabled={!dirty} loading={pending}>
              Test and apply
            </Button>
          </div>
        </CardFooter>
      </form>
    </Card>
  );
}

function ProxyLogs({ serverId }: { serverId: string }) {
  const [lines, setLines] = React.useState<LogLine[]>([]);
  const [loading, setLoading] = React.useState(false);
  const load = React.useCallback(async () => {
    setLoading(true);
    const res = await getProxyLogs(serverId);
    setLoading(false);
    setLines(res.ok ? res.data.map((l) => ({ text: l.text, time: "time" in l ? l.time : undefined })) : [{ text: res.error, error: true }]);
  }, [serverId]);

  React.useEffect(() => {
    let cancelled = false;
    void getProxyLogs(serverId).then((res) => {
      if (cancelled) return;
      setLines(res.ok ? res.data.map((l) => ({ text: l.text, time: "time" in l ? l.time : undefined })) : [{ text: res.error, error: true }]);
    });
    return () => {
      cancelled = true;
    };
  }, [serverId]);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex flex-col">
          <h2 className="text-[15px] font-semibold text-fg">Logs</h2>
          <p className="text-[13px] text-muted">Proxy output, newest last.</p>
        </div>
        <Button size="sm" onClick={load} loading={loading}>
          <RotateCw /> Refresh
        </Button>
      </div>
      <LogViewer lines={lines} showTime height="min(50vh, 420px)" emptyText="No proxy output yet." filename="proxy.log" />
    </div>
  );
}
