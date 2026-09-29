"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Check, FileCode2, Power, RefreshCw, RotateCw, TriangleAlert, Wrench } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardBody, CardFooter, CardHeader, EmptyState, TimeAgo } from "@/components/ui/misc";
import { Led } from "@/components/ui/status";
import { Textarea } from "@/components/ui/input";
import { Dialog, DialogBody, DialogContent, DialogHeader } from "@/components/ui/dialog";
import { useConfirm } from "@/components/ui/confirm";
import { LogViewer, type LogLine } from "@/components/log-viewer";
import { useAction } from "@/hooks/use-action";
import { toast } from "@/components/ui/toast";
import { getProxyLogs, getSiteFile, rebuildProxyNow, reloadProxyNow, restartProxyNow, saveProxyCustomConfig } from "@/server/actions/server-proxy";
import { cn, formatBytes } from "@/lib/utils";

type SiteFile = { file: string; kind: "dashboard" | "service" | "custom" | "other"; label: string; href: string | null; size: number; updatedAt: string };

export function ProxyView({
  serverId,
  status,
  test,
  customConfig,
  maxBodySize,
  files,
}: {
  serverId: string;
  status: { running: boolean; exists: boolean; image: string; startedAt: string | null; container: string; ports: { http: number; https: number } };
  test: { ok: boolean; output: string };
  customConfig: string;
  maxBodySize: string;
  files: SiteFile[];
}) {
  const confirm = useConfirm();
  const reload = useAction(() => reloadProxyNow(serverId), { success: "Proxy reloaded" });
  const restart = useAction(() => restartProxyNow(serverId), { success: "Proxy restarted" });
  const rebuild = useAction(() => rebuildProxyNow(serverId), { success: "Rebuilding proxy configuration" });

  return (
    <>
      <Card>
        <CardHeader
          title="nginx proxy"
          description="Routes every domain on this server to its app and serves TLS."
          actions={
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={() => reload.run()} loading={reload.pending} disabled={!status.running}>
                <RefreshCw /> Reload
              </Button>
              <Button
                size="sm"
                onClick={async () => {
                  if (await confirm({ title: "Restart the proxy?", description: "Every site is unreachable for a few seconds while nginx restarts. Reload is usually enough.", confirmLabel: "Restart" }))
                    restart.run();
                }}
                loading={restart.pending}
              >
                <Power /> Restart
              </Button>
            </div>
          }
        />
        <dl className="grid grid-cols-1 divide-y divide-line sm:grid-cols-2 sm:divide-y-0">
          <div className="flex min-w-0 flex-col divide-y divide-line">
            <Row label="Status">
              <span className="flex items-center gap-2">
                <Led color={status.running ? "var(--ok)" : "var(--bad)"} />
                {status.running ? (
                  <>
                    Running{status.startedAt && <span className="text-muted">· <TimeAgo date={status.startedAt} /></span>}
                  </>
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
            <Row label="Sites">{files.filter((f) => f.kind !== "custom").length}</Row>
            <Row label="Max upload">
              <code className="font-mono text-xs">{maxBodySize}</code>
            </Row>
          </div>
        </dl>
        <div className={cn("flex items-start gap-2.5 border-t border-line px-5 py-3 text-[13px]", test.ok ? "text-fg-2" : "bg-bad-soft/50")}>
          {test.ok ? <Check className="mt-0.5 size-4 flex-none text-ok" /> : <TriangleAlert className="mt-0.5 size-4 flex-none text-bad" />}
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <span className={test.ok ? undefined : "font-medium text-fg"}>{test.ok ? "Configuration test passed" : "Configuration test failed"}</span>
            {!test.ok && <pre className="overflow-x-auto font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap text-muted">{test.output}</pre>}
          </div>
          <Button size="xs" variant="ghost" onClick={() => rebuild.run()} loading={rebuild.pending} className="flex-none">
            <Wrench /> Rebuild configs
          </Button>
        </div>
      </Card>

      <CustomConfigCard initial={customConfig} />

      <Card>
        <CardHeader title="Site files" description="Generated by Serve for each service with a domain. Changes are overwritten." />
        {files.length === 0 ? (
          <EmptyState icon={<FileCode2 />} title="No sites yet" description="A site file appears when a service gets a domain." />
        ) : (
          <SiteFiles serverId={serverId} files={files} />
        )}
      </Card>

      <ProxyLogs serverId={serverId} />
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
          title="Custom configuration"
          description={
            <>
              Extra directives for nginx&apos;s <code className="font-mono text-[12px]">http</code> block, like timeouts, headers or rate limit zones. Serve tests them with{" "}
              <code className="font-mono text-[12px]">nginx -t</code> before applying. They apply to the proxy on every server.
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
              <Button type="button" variant="ghost" size="sm" onClick={() => { setValue(saved); setError(null); }}>
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

function SiteFiles({ serverId, files }: { serverId: string; files: SiteFile[] }) {
  const [open, setOpen] = React.useState<SiteFile | null>(null);
  const [content, setContent] = React.useState<string | null>(null);

  const view = async (f: SiteFile) => {
    setOpen(f);
    setContent(null);
    const res = await getSiteFile(serverId, f.file);
    setContent(res.ok ? res.data : res.error);
  };

  return (
    <>
      <div className="divide-y divide-line">
        {files.map((f) => (
          <div key={f.file} className="flex items-center gap-3 px-5 py-3">
            <span className="flex size-8 flex-none items-center justify-center rounded-lg border border-line bg-surface-2 text-muted">
              <FileCode2 className="size-4" />
            </span>
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="flex min-w-0 items-center gap-2 text-[13px] font-medium text-fg">
                {f.href ? (
                  <Link href={f.href} className="truncate hover:underline">
                    {f.label}
                  </Link>
                ) : (
                  <span className="truncate">{f.label}</span>
                )}
                {f.kind === "dashboard" && <Badge tone="accent">Dashboard</Badge>}
              </span>
              <span className="truncate font-mono text-[11.5px] text-muted">
                {f.file} · {formatBytes(f.size)} · <TimeAgo date={f.updatedAt} />
              </span>
            </div>
            <Button size="xs" onClick={() => view(f)}>
              View
            </Button>
          </div>
        ))}
      </div>
      <Dialog open={!!open} onOpenChange={(o) => !o && setOpen(null)}>
        <DialogContent size="xl">
          <DialogHeader title={open?.label ?? ""} description={<code className="font-mono text-[12px]">{open?.file}</code>} />
          <DialogBody>
            <pre className="scrollbar-thin max-h-[60vh] overflow-auto rounded-xl bg-log-bg p-4 font-mono text-[12px] leading-relaxed text-log-fg">
              {content ?? "Loading…"}
            </pre>
          </DialogBody>
        </DialogContent>
      </Dialog>
    </>
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
          <p className="text-[13px] text-muted">nginx errors and warnings, newest last.</p>
        </div>
        <Button size="sm" onClick={load} loading={loading}>
          <RotateCw /> Refresh
        </Button>
      </div>
      <LogViewer lines={lines} showTime height="min(50vh, 420px)" emptyText="No proxy output yet." filename="proxy.log" />
    </div>
  );
}
