"use client";

import * as React from "react";
import { useRouter } from "@/hooks/use-router";
import { ArrowLeft, ArrowRight, Check, Globe, HardDrive, Rocket, Server } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/misc";
import { Led } from "@/components/ui/status";
import { toast } from "@/components/ui/toast";
import { saveServerSettings, finishOnboarding, detectIp } from "@/server/actions/server";
import { createProject } from "@/server/actions/projects";
import { AddServer } from "@/app/(app)/servers/new/add-server";
import { cn, formatBytes } from "@/lib/utils";

type Initial = { instanceName: string; serverIp: string };

type Status = {
  docker: string | null;
  dockerError: string | null;
  proxyRunning: boolean;
  nixpacks: boolean;
  hostname: string;
  cpus: number;
  memory: number;
  platform: string;
};

type Key = { id: string; name: string; publicKey: string; fingerprint: string };

const steps = [
  { id: "server", title: "Server", hint: "Where apps run", icon: Server },
  { id: "project", title: "First project", hint: "Start deploying", icon: Rocket },
] as const;

type StepId = (typeof steps)[number]["id"];

function CheckRow({ ok, label, detail }: { ok: boolean; label: string; detail?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2.5">
      <span className="flex shrink-0 items-center gap-3 text-[13px] text-fg-2">
        <Led color={ok ? "var(--ok)" : "var(--warn)"} />
        {label}
      </span>
      <span className="truncate text-right text-xs text-muted">{detail}</span>
    </div>
  );
}

export function OnboardingWizard({
  userName,
  initial,
  status,
  keys,
  tunnel,
  hasProject,
}: {
  userName: string;
  initial: Initial;
  status: Status;
  keys: Key[];
  tunnel: { address: string; port: number };
  hasProject: boolean;
}) {
  const router = useRouter();
  const [step, setStep] = React.useState<StepId>("server");
  const [done, setDone] = React.useState<Set<StepId>>(new Set());
  const [where, setWhere] = React.useState<"local" | "remote">("local");
  const [values, setValues] = React.useState(initial);
  const [pending, setPending] = React.useState(false);
  const [projectName, setProjectName] = React.useState("My first project");

  const index = steps.findIndex((s) => s.id === step);
  const set = <K extends keyof Initial>(k: K, v: Initial[K]) => setValues((prev) => ({ ...prev, [k]: v }));
  const next = () => {
    setDone((d) => new Set(d).add(step));
    setStep("project");
  };

  async function saveLocal() {
    setPending(true);
    const res = await saveServerSettings({ instanceName: values.instanceName, serverIp: values.serverIp }).finally(() => setPending(false));
    if (!res.ok) return toast.error(res.error);
    next();
  }

  // The project made by an earlier try: a retry after finishOnboarding failed must not make a second one.
  const created = React.useRef<string | null>(null);
  async function finish() {
    setPending(true);
    if (!hasProject && !created.current && projectName.trim()) {
      const res = await createProject({ name: projectName });
      if (!res.ok) {
        setPending(false);
        return toast.error(res.error);
      }
      created.current = res.data.id;
    }
    const target = created.current ? `/projects/${created.current}` : "/";
    const res = await finishOnboarding();
    if (!res.ok) {
      setPending(false);
      return toast.error(res.error);
    }
    router.replace(target);
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-2">
        <p className="text-[13px] font-semibold text-accent">Setup guide</p>
        <h1 className="text-[32px] leading-tight font-semibold tracking-tight">Welcome, {userName.split(" ")[0]}.</h1>
        <p className="max-w-xl text-[14px] leading-relaxed text-muted">
          Pick where your apps run and create a project. Domains, HTTPS, Cloudflare and Git can be set up later in Settings.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-6 md:grid-cols-[200px_1fr]">
        {/* Compact progress for small screens */}
        <div className="flex flex-col gap-2.5 md:hidden">
          <div className="flex items-baseline justify-between">
            <span className="text-[13px] font-medium text-fg">{steps[index].title}</span>
            <span className="text-xs text-faint tabular-nums">
              Step {index + 1} of {steps.length}
            </span>
          </div>
          <div className="grid grid-cols-2 gap-1.5">
            {steps.map((s, i) => (
              <span key={s.id} className={cn("h-1.5 rounded-full transition-colors duration-300", i === index ? "bg-accent" : done.has(s.id) ? "bg-ok" : "bg-line")} />
            ))}
          </div>
        </div>

        {/* Step rail for larger screens */}
        <ol className="relative hidden flex-col self-start md:flex">
          <span aria-hidden className="absolute top-5 bottom-5 left-[19px] w-px bg-line" />
          {steps.map((s, i) => {
            const active = s.id === step;
            const complete = done.has(s.id);
            const reachable = complete || i <= index;
            return (
              <li key={s.id}>
                <button
                  type="button"
                  disabled={!reachable}
                  onClick={() => setStep(s.id)}
                  className={cn(
                    "relative flex w-full items-center gap-3 rounded-lg px-1.5 py-2 text-left transition-colors disabled:cursor-default",
                    active ? "bg-hover/70" : reachable && "hover:bg-hover/50",
                  )}
                >
                  <span
                    className={cn(
                      "relative z-10 flex size-7 shrink-0 items-center justify-center rounded-full border text-[11px] font-semibold tabular-nums transition-all duration-300",
                      active
                        ? "border-accent bg-accent text-accent-fg shadow-[0_0_0_4px_var(--accent-soft)]"
                        : complete
                          ? "border-transparent bg-ok text-bg"
                          : "border-line-strong bg-surface text-faint",
                    )}
                  >
                    {complete && !active ? <Check className="size-3.5" strokeWidth={3} /> : i + 1}
                  </span>
                  <span className="flex min-w-0 flex-col leading-tight">
                    <span className={cn("text-[13px] font-medium", active ? "text-fg" : complete ? "text-fg-2" : "text-muted")}>{s.title}</span>
                    <span className="text-[11px] text-faint">{s.hint}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ol>

        {step === "server" ? (
          <div key="server" className="flex min-w-0 animate-rise flex-col gap-5">
            <Card className="overflow-hidden">
              <StepHeader icon={Server} title="Where should apps run?" description="Use this machine, or connect another one. You can add more servers later." />
              <div className="flex flex-col gap-5 px-5 py-6 sm:px-6">
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Where apps run">
                  {(
                    [
                      ["local", "This machine", `${status.hostname} · ${status.cpus} CPU · ${formatBytes(status.memory, 0)}`, HardDrive],
                      ["remote", "Another server", "A VPS over SSH, or a machine behind NAT", Globe],
                    ] as const
                  ).map(([value, label, hint, Icon]) => (
                    <button
                      key={value}
                      type="button"
                      role="radio"
                      aria-checked={where === value}
                      onClick={() => setWhere(value)}
                      className={cn(
                        "flex items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition-[border-color,background-color,box-shadow]",
                        where === value ? "border-accent bg-accent-soft/50 ring-3 ring-[var(--ring)]/25" : "border-line bg-surface hover:bg-surface-2",
                      )}
                    >
                      <Icon className={cn("size-4 flex-none", where === value ? "text-accent" : "text-muted")} />
                      <span className="flex min-w-0 flex-col">
                        <span className="text-[13px] font-medium text-fg">{label}</span>
                        <span className="truncate text-[11.5px] text-muted">{hint}</span>
                      </span>
                    </button>
                  ))}
                </div>

                {where === "local" && (
                  <>
                    <div className="divide-y divide-line rounded-lg border border-line px-4">
                      <CheckRow ok={!!status.docker} label="Docker engine" detail={status.docker ? `v${status.docker}` : (status.dockerError ?? "Not reachable")} />
                      <CheckRow ok={status.proxyRunning} label="Proxy" detail={status.proxyRunning ? "Running" : "Starts with the worker"} />
                      <CheckRow ok={status.nixpacks} label="Nixpacks builder" detail={status.nixpacks ? "Installed" : "Optional: the built-in builder is used"} />
                    </div>
                    <Field label="Server name" description="Shown in the dashboard and notifications.">
                      <Input value={values.instanceName} onChange={(e) => set("instanceName", e.target.value)} />
                    </Field>
                    <Field label="Public IPv4 address" description="Used for DNS records and automatic sslip.io domains.">
                      <div className="flex gap-2">
                        <Input value={values.serverIp} onChange={(e) => set("serverIp", e.target.value)} placeholder="203.0.113.10" className="font-mono" />
                        <Button
                          onClick={async () => {
                            const res = await detectIp();
                            if (res.ok) set("serverIp", res.data);
                            else toast.error(res.error);
                          }}
                        >
                          Detect
                        </Button>
                      </div>
                    </Field>
                  </>
                )}
              </div>
              {where === "local" && (
                <div className="flex items-center justify-end gap-3 border-t border-line bg-surface-2 px-5 py-3 sm:px-6">
                  <Button variant="primary" size="sm" loading={pending} onClick={saveLocal}>
                    Continue <ArrowRight />
                  </Button>
                </div>
              )}
            </Card>
            {where === "remote" && <AddServer keys={keys} tunnel={tunnel} onFinished={next} />}
          </div>
        ) : (
          <Card key="project" className="animate-rise overflow-hidden">
            <StepHeader icon={Rocket} title="Create your first project" description="Projects group related apps and databases, like a website and its database." />
            <div className="flex flex-col gap-5 px-5 py-6 sm:px-6">
              {hasProject ? (
                <div className="flex items-start gap-3 rounded-lg border border-ok/30 bg-ok-soft p-4 text-[13px] text-fg-2">
                  <Check className="mt-0.5 size-4 text-ok" />
                  You already have a project. Finish to open your dashboard.
                </div>
              ) : (
                <Field label="Project name">
                  <Input value={projectName} onChange={(e) => setProjectName(e.target.value)} autoFocus />
                </Field>
              )}
            </div>
            <div className="flex items-center justify-between gap-3 border-t border-line bg-surface-2 px-5 py-3 sm:px-6">
              <Button variant="ghost" size="sm" onClick={() => setStep("server")}>
                <ArrowLeft /> Back
              </Button>
              <Button variant="primary" size="sm" loading={pending} onClick={finish} disabled={!hasProject && !projectName.trim()}>
                Finish setup
              </Button>
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}

function StepHeader({ icon: Icon, title, description }: { icon: typeof Server; title: string; description: string }) {
  return (
    <div className="flex items-center gap-3 border-b border-line px-5 py-5 sm:px-6">
      <span className="flex size-9 items-center justify-center rounded-lg border border-line bg-surface-2 text-fg-2">
        <Icon className="size-4" />
      </span>
      <div className="flex flex-col">
        <h2 className="text-[17px] font-semibold">{title}</h2>
        <p className="text-[13px] text-muted">{description}</p>
      </div>
    </div>
  );
}
