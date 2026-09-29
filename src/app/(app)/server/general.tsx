"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { RefreshCw, Server } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, TimeAgo } from "@/components/ui/misc";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Combobox } from "@/components/ui/combobox";
import { Tooltip } from "@/components/ui/tooltip";
import { detectIp } from "@/server/actions/server";
import type { hostInfo, ServerHealth } from "@/server/system";
import { cn, formatBytes } from "@/lib/utils";
import { SettingsCard } from "./_components/settings-card";

type Host = Awaited<ReturnType<typeof hostInfo>>;

function Fact({ label, children, mono }: { label: string; children: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className={cn("truncate text-[14px] text-fg", mono && "font-mono text-[13px]")}>{children}</dd>
    </div>
  );
}

function Check({ ok, label, detail, optional }: { ok: boolean; label: string; detail: React.ReactNode; optional?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-4 px-5 py-2.5 text-[13px]">
      <span className="flex flex-none items-center gap-2.5 text-fg-2">
        <span className={cn("size-1.5 rounded-full", ok ? "bg-ok" : optional ? "bg-idle" : "bg-bad")} />
        {label}
      </span>
      <span className="min-w-0 truncate text-right text-muted">{detail}</span>
    </div>
  );
}

export function ServerOverview({
  host,
  health,
  extra,
}: {
  host: Host;
  health: ServerHealth & { proxyStartedAt: string | null };
  extra: { nixpacks: boolean; dataDir: string; proxyPorts: string };
}) {
  const router = useRouter();
  const [refreshing, startRefresh] = React.useTransition();
  const ready = health.issues.length === 0;
  return (
    <Card>
      <CardHeader
        title="Overview"
        actions={
          <Tooltip content="Refresh">
            <Button size="icon-sm" variant="ghost" aria-label="Refresh" onClick={() => startRefresh(() => router.refresh())}>
              <RefreshCw className={cn(refreshing && "animate-spin")} />
            </Button>
          </Tooltip>
        }
      />
      <div className="flex items-start gap-3.5 px-5 pt-5">
        <span className="flex size-10 flex-none items-center justify-center rounded-xl bg-fg text-bg">
          <Server className="size-5" />
        </span>
        <div className="min-w-0">
          <p className="truncate text-[15px] font-semibold text-fg">{host.name}</p>
          <p className="text-[13px] text-muted">
            {ready ? "Reachable and ready to run your services." : `Needs attention: ${health.issues.join(", ").toLowerCase()}.`}
          </p>
        </div>
      </div>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-5 px-5 py-5 sm:grid-cols-3">
        <Fact label="Operating system">{host.os}</Fact>
        <Fact label="Architecture">{host.arch}</Fact>
        <Fact label="Kernel">{host.kernel}</Fact>
        <Fact label="CPU cores">{host.cpus}</Fact>
        <Fact label="Memory">{formatBytes(host.memory, 1)}</Fact>
        <Fact label="Up since">
          <Tooltip content={new Date(host.upSince).toLocaleString()}>
            <span>
              <TimeAgo date={host.upSince} />
            </span>
          </Tooltip>
        </Fact>
        <Fact label="Docker">{host.docker ?? "Unavailable"}</Fact>
        <Fact label="Compose">{host.compose ?? "Not installed"}</Fact>
        <Fact label="Buildx">{host.buildx ?? "Not installed"}</Fact>
      </dl>
      <div className="flex flex-col divide-y divide-line border-t border-line">
        <Check ok={health.docker} label="Docker engine" detail={health.docker ? `${host.containers.running} of ${host.containers.total} containers running` : "Not reachable"} />
        <Check
          ok={health.proxy}
          label="nginx proxy"
          detail={
            health.proxy ? (
              <>
                Running · ports {extra.proxyPorts}
                {health.proxyStartedAt && (
                  <>
                    {" "}
                    · <TimeAgo date={health.proxyStartedAt} />
                  </>
                )}
              </>
            ) : (
              "Not running"
            )
          }
        />
        <Check ok={health.worker} label="Worker" detail={health.worker ? "Running" : "Not running, jobs are waiting"} />
        <Check ok={extra.nixpacks} optional label="Nixpacks" detail={extra.nixpacks ? "Installed" : "Not installed, auto detection is used"} />
        <div className="flex items-center justify-between gap-4 px-5 py-2.5 text-[13px]">
          <span className="flex-none text-fg-2">Data directory</span>
          <code className="min-w-0 truncate font-mono text-xs text-muted">{extra.dataDir}</code>
        </div>
      </div>
    </Card>
  );
}

let zones: { value: string; label: string; description: string }[] | null = null;
function timezoneOptions() {
  if (zones) return zones;
  const now = new Date();
  const list = ["UTC", ...Intl.supportedValuesOf("timeZone").filter((z) => z !== "UTC")];
  zones = list.map((tz) => {
    const offset = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "shortOffset" }).formatToParts(now).find((p) => p.type === "timeZoneName")?.value ?? "";
    return { value: tz, label: tz.replace(/_/g, " "), description: offset.replace("GMT", "UTC") || "UTC" };
  });
  return zones;
}

export function GeneralSettings({ initial }: { initial: { instanceName: string; serverIp: string; timezone: string } }) {
  const [detecting, setDetecting] = React.useState(false);
  return (
    <SettingsCard title="General" description="How this server is named and reached." initial={initial}>
      {(v, set) => (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Server name" description="Shown in the browser tab and emails.">
              <Input value={v.instanceName} onChange={(e) => set("instanceName")(e.target.value)} />
            </Field>
            <Field label="Public IPv4" description="Used for DNS records and generated domains.">
              <div className="flex gap-2">
                <Input value={v.serverIp} onChange={(e) => set("serverIp")(e.target.value)} className="font-mono" placeholder="203.0.113.10" />
                <Button
                  loading={detecting}
                  onClick={async () => {
                    setDetecting(true);
                    const r = await detectIp();
                    setDetecting(false);
                    if (r.ok) set("serverIp")(r.data);
                  }}
                >
                  Detect
                </Button>
              </div>
            </Field>
          </div>
          <Field label="Timezone" description="Backup schedules and scheduled tasks run in this timezone.">
            <Combobox value={v.timezone} onValueChange={set("timezone")} options={timezoneOptions()} placeholder="Search timezones" className="sm:max-w-sm" />
          </Field>
        </>
      )}
    </SettingsCard>
  );
}
