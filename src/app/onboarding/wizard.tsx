"use client";

import * as React from "react";
import { useRouter } from "@/hooks/use-router";
import { ArrowLeft, ArrowRight, Check, Cloud, FolderGit2, Globe, Rocket, Server, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input, InputGroup } from "@/components/ui/input";
import { SwitchRow } from "@/components/ui/switch";
import { Card, CopyField } from "@/components/ui/misc";
import { Led } from "@/components/ui/status";
import { toast } from "@/components/ui/toast";
import { saveServerSettings, finishOnboarding, detectIp } from "@/server/actions/server";
import { connectCloudflare, startGithubApp } from "@/server/actions/integrations";
import { postManifest } from "@/lib/github";
import { GithubMark } from "@/components/github-mark";
import { createProject } from "@/server/actions/projects";
import { cn, formatBytes } from "@/lib/utils";
import { ProductName } from "@/components/brand";

type Initial = {
  instanceName: string;
  serverIp: string;
  wildcardDomain: string;
  dashboardDomain: string;
  sslipFallback: boolean;
  acmeEmail: string;
  acmeStaging: boolean;
};

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

const steps = [
  { id: "server", title: "Server", hint: "Name and address", icon: Server },
  { id: "domains", title: "Domains", hint: "Where apps live", icon: Globe },
  { id: "ssl", title: "HTTPS", hint: "Free certificates", icon: ShieldCheck },
  { id: "cloudflare", title: "Cloudflare", hint: "Optional", icon: Cloud },
  { id: "git", title: "Git", hint: "Optional", icon: FolderGit2 },
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
  counts,
  initialStep,
  notice,
}: {
  initialStep?: StepId | null;
  notice?: string | null;
  userName: string;
  initial: Initial;
  status: Status;
  counts: { cloudflare: number; git: number; hasProject: boolean };
}) {
  const router = useRouter();
  const [step, setStep] = React.useState<StepId>(initialStep ?? "server");
  const [done, setDone] = React.useState<Set<StepId>>(
    () =>
      new Set(
        initialStep
          ? steps
              .slice(
                0,
                steps.findIndex((s) => s.id === initialStep),
              )
              .map((s) => s.id)
          : [],
      ),
  );
  const [values, setValues] = React.useState(initial);
  const [pending, setPending] = React.useState(false);
  const [cf, setCf] = React.useState({ token: "", connected: counts.cloudflare > 0 });
  const git = { connected: counts.git > 0 };
  const announced = React.useRef(false);
  React.useEffect(() => {
    if (!notice || announced.current) return;
    announced.current = true;
    toast.error("GitHub setup did not finish", notice);
  }, [notice]);
  const [connecting, setConnecting] = React.useState(false);
  async function connectGithub() {
    setConnecting(true);
    const res = await startGithubApp({});
    if (!res.ok) {
      setConnecting(false);
      return toast.error(res.error);
    }
    postManifest(res.data.action, res.data.manifest);
  }
  const [projectName, setProjectName] = React.useState("My first project");

  const index = steps.findIndex((s) => s.id === step);
  const set = <K extends keyof Initial>(k: K, v: Initial[K]) => setValues((prev) => ({ ...prev, [k]: v }));

  const next = () => {
    setDone((d) => new Set(d).add(step));
    const n = steps[index + 1];
    if (n) setStep(n.id);
  };
  const back = () => {
    const p = steps[index - 1];
    if (p) setStep(p.id);
  };

  async function save(patch: Partial<Initial>) {
    setPending(true);
    const res = await saveServerSettings(patch);
    setPending(false);
    if (!res.ok) {
      toast.error(res.error);
      return false;
    }
    return true;
  }

  async function onContinue() {
    if (step === "server") {
      if (await save({ instanceName: values.instanceName, serverIp: values.serverIp })) next();
    } else if (step === "domains") {
      if (await save({ wildcardDomain: values.wildcardDomain, dashboardDomain: values.dashboardDomain, sslipFallback: values.sslipFallback })) next();
    } else if (step === "ssl") {
      if (await save({ acmeEmail: values.acmeEmail, acmeStaging: values.acmeStaging })) next();
    } else if (step === "cloudflare") {
      if (cf.connected || !cf.token.trim()) return next();
      setPending(true);
      const res = await connectCloudflare({ name: "", apiToken: cf.token });
      setPending(false);
      if (!res.ok) return toast.error(res.error);
      toast.success(`Cloudflare connected · ${res.data.zones} zones`);
      setCf({ token: "", connected: true });
      next();
    } else if (step === "git") {
      next();
    } else if (step === "project") {
      setPending(true);
      let target = "/";
      if (!counts.hasProject && projectName.trim()) {
        const res = await createProject({ name: projectName });
        if (!res.ok) {
          setPending(false);
          return toast.error(res.error);
        }
        target = `/projects/${res.data.id}`;
      }
      const res = await finishOnboarding();
      if (!res.ok) {
        setPending(false);
        return toast.error(res.error);
      }
      router.replace(target);
      router.refresh();
    }
  }

  const optional = step === "cloudflare" || step === "git";
  const Icon = steps[index].icon;

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-2">
        <p className="text-[13px] font-semibold text-accent">Setup guide</p>
        <h1 className="text-[32px] leading-tight font-semibold tracking-tight">Welcome, {userName.split(" ")[0]}.</h1>
        <p className="max-w-xl text-[14px] leading-relaxed text-muted">
          A few settings and your server is ready to host apps, databases and services. You can change all of this later in Server settings.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-6 md:grid-cols-[220px_1fr]">
        {/* Compact progress for small screens */}
        <div className="flex flex-col gap-2.5 md:hidden">
          <div className="flex items-baseline justify-between">
            <span className="text-[13px] font-medium text-fg">{steps[index].title}</span>
            <span className="text-xs text-faint tabular-nums">
              Step {index + 1} of {steps.length}
            </span>
          </div>
          <div className="grid grid-cols-6 gap-1.5">
            {steps.map((s, i) => (
              <button
                key={s.id}
                type="button"
                aria-label={s.title}
                onClick={() => (done.has(s.id) || i <= index ? setStep(s.id) : undefined)}
                className={cn("h-1.5 rounded-full transition-colors duration-300", i === index ? "bg-accent" : done.has(s.id) ? "bg-ok" : "bg-line")}
              />
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

        <Card key={step} className="animate-rise overflow-hidden">
          <div className="flex items-center gap-3 border-b border-line px-5 py-5 sm:px-6">
            <span className="flex size-9 items-center justify-center rounded-lg border border-line bg-surface-2 text-fg-2">
              <Icon className="size-4" />
            </span>
            <div className="flex flex-col">
              <h2 className="text-[17px] font-semibold">{stepTitle(step)}</h2>
              <p className="text-[13px] text-muted">{stepDescription(step)}</p>
            </div>
          </div>

          <div className="flex flex-col gap-5 px-5 py-6 sm:px-6">
            {step === "server" && (
              <>
                <div className="divide-y divide-line rounded-lg border border-line px-4">
                  <CheckRow ok={!!status.docker} label="Docker engine" detail={status.docker ? `v${status.docker}` : (status.dockerError ?? "Not reachable")} />
                  <CheckRow ok={status.proxyRunning} label="nginx proxy" detail={status.proxyRunning ? "Running" : "Starts with the worker"} />
                  <CheckRow ok label="Machine" detail={`${status.hostname} · ${status.cpus} CPU · ${formatBytes(status.memory, 0)}`} />
                  <CheckRow ok={status.nixpacks} label="Nixpacks builder" detail={status.nixpacks ? "Installed" : "Optional — built-in builder is used"} />
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

            {step === "domains" && (
              <>
                <Field
                  label="Wildcard domain for apps"
                  optional
                  description={
                    <>
                      New apps get <code className="text-fg-2">app-name.{values.wildcardDomain || "apps.example.com"}</code> automatically. Point{" "}
                      <code className="text-fg-2">*.{values.wildcardDomain || "apps.example.com"}</code> to this server.
                    </>
                  }
                >
                  <InputGroup prefix="*.">
                    <Input value={values.wildcardDomain} onChange={(e) => set("wildcardDomain", e.target.value)} placeholder="apps.example.com" />
                  </InputGroup>
                </Field>
                <Field label="Dashboard domain" optional description="Serve this dashboard on its own domain with HTTPS.">
                  <Input value={values.dashboardDomain} onChange={(e) => set("dashboardDomain", e.target.value)} placeholder="serve.example.com" />
                </Field>
                <SwitchRow
                  title="Use sslip.io when there is no wildcard domain"
                  description={`Apps get a working URL like app.${values.serverIp || "203.0.113.10"}.sslip.io with no DNS setup.`}
                  checked={values.sslipFallback}
                  onCheckedChange={(v) => set("sslipFallback", v)}
                />
                {(values.wildcardDomain || values.dashboardDomain) && values.serverIp && (
                  <div className="flex flex-col gap-2 rounded-lg border border-line bg-surface-2 p-4">
                    <p className="text-[13px] font-medium text-fg-2">Create these DNS records</p>
                    {values.wildcardDomain && (
                      <div className="grid grid-cols-[48px_1fr] items-center gap-2 text-xs">
                        <span className="font-mono text-muted">A</span>
                        <CopyField value={`*.${values.wildcardDomain}  →  ${values.serverIp}`} />
                      </div>
                    )}
                    {values.dashboardDomain && (
                      <div className="grid grid-cols-[48px_1fr] items-center gap-2 text-xs">
                        <span className="font-mono text-muted">A</span>
                        <CopyField value={`${values.dashboardDomain}  →  ${values.serverIp}`} />
                      </div>
                    )}
                    <p className="text-xs text-muted">
                      Using Cloudflare? Connect it in the next steps and <ProductName /> creates records for you.
                    </p>
                  </div>
                )}
              </>
            )}

            {step === "ssl" && (
              <>
                <Field label="Email for Let's Encrypt" description="Used for certificate expiry notices. Certificates are issued and renewed automatically.">
                  <Input type="email" value={values.acmeEmail} onChange={(e) => set("acmeEmail", e.target.value)} placeholder="ops@example.com" />
                </Field>
                <SwitchRow
                  title="Use the Let's Encrypt staging server"
                  description="For testing only. Staging certificates are not trusted by browsers but have higher rate limits."
                  checked={values.acmeStaging}
                  onCheckedChange={(v) => set("acmeStaging", v)}
                />
                <div className="rounded-lg border border-line bg-surface-2 p-4 text-[13px] leading-relaxed text-muted">
                  <ProductName /> supports three ways to get certificates: <span className="text-fg-2">HTTP validation</span> (port 80 must be open),{" "}
                  <span className="text-fg-2">Cloudflare DNS validation</span> (works for wildcards and servers behind firewalls), and{" "}
                  <span className="text-fg-2">Cloudflare Origin certificates</span> (valid up to 15 years for proxied domains).
                </div>
              </>
            )}

            {step === "cloudflare" &&
              (cf.connected ? (
                <ConnectedNote text="Cloudflare is connected. You can manage DNS, SSL modes and certificates from the Cloudflare page." />
              ) : (
                <>
                  <Field
                    label="API token"
                    description={
                      <>
                        Create a token at dash.cloudflare.com → My Profile → API Tokens with <span className="text-fg-2">Zone · Read</span>,{" "}
                        <span className="text-fg-2">DNS · Edit</span> and <span className="text-fg-2">SSL and Certificates · Edit</span>.
                      </>
                    }
                  >
                    <Input type="password" value={cf.token} onChange={(e) => setCf({ ...cf, token: e.target.value })} placeholder="Paste token" className="font-mono" />
                  </Field>
                  <p className="text-[13px] text-muted">With Cloudflare connected, adding a domain can create its DNS record and certificate in one step.</p>
                </>
              ))}

            {step === "git" &&
              (git.connected ? (
                <ConnectedNote text="GitHub is connected. Private repositories appear when you create a service, and pushes deploy automatically." />
              ) : (
                <div className="flex flex-col gap-4">
                  <div className="flex items-start gap-4 rounded-xl border border-line bg-surface-2 p-4">
                    <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-fg text-bg">
                      <GithubMark className="size-5" />
                    </span>
                    <div className="flex flex-col gap-1">
                      <p className="text-[14px] font-medium text-fg">Connect GitHub with a GitHub App</p>
                      <p className="text-[13px] leading-relaxed text-muted">
                        <ProductName /> creates a private app for this server. You choose the repositories it can read, and pushes and pull requests deploy automatically.
                      </p>
                    </div>
                  </div>
                  <Button variant="secondary" onClick={connectGithub} loading={connecting} className="w-fit">
                    <GithubMark className="size-4" /> Continue on GitHub
                  </Button>
                  <p className="text-[13px] text-muted">Public repositories work without this. GitLab, Gitea, Bitbucket and SSH keys can be added later in Git providers.</p>
                </div>
              ))}

            {step === "project" &&
              (counts.hasProject ? (
                <ConnectedNote text="You already have a project. Finish to open your dashboard." />
              ) : (
                <>
                  <Field label="Project name" description="Projects group related apps and databases, like a website and its database.">
                    <Input value={projectName} onChange={(e) => setProjectName(e.target.value)} autoFocus />
                  </Field>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                    {[
                      ["Deploy from Git", "Push to deploy with automatic builds."],
                      ["Add a database", "Postgres, MySQL, Redis and more."],
                      ["One-click services", "n8n, Umami, Ghost and others."],
                    ].map(([title, body]) => (
                      <div key={title} className="rounded-lg border border-line bg-surface-2 p-3">
                        <p className="text-[13px] font-medium text-fg">{title}</p>
                        <p className="mt-0.5 text-xs leading-relaxed text-muted">{body}</p>
                      </div>
                    ))}
                  </div>
                </>
              ))}
          </div>

          <div className="flex items-center justify-between gap-3 border-t border-line bg-surface-2 px-5 py-3 sm:px-6">
            <Button variant="ghost" size="sm" onClick={back} disabled={index === 0}>
              <ArrowLeft /> Back
            </Button>
            <div className="flex items-center gap-2">
              {optional && !(step === "cloudflare" ? cf.connected : git.connected) && (
                <Button variant="ghost" size="sm" onClick={next}>
                  Skip for now
                </Button>
              )}
              <Button variant="primary" size="sm" loading={pending} onClick={onContinue}>
                {step === "project" ? "Finish setup" : "Continue"} {step !== "project" && <ArrowRight />}
              </Button>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}

function ConnectedNote({ text }: { text: string }) {
  return (
    <div className="flex items-start gap-3 rounded-lg border border-ok/30 bg-ok-soft p-4 text-[13px] text-fg-2">
      <Check className="mt-0.5 size-4 text-ok" />
      {text}
    </div>
  );
}

function stepTitle(step: StepId) {
  return {
    server: "Check your server",
    domains: "Choose domains",
    ssl: "Set up HTTPS",
    cloudflare: "Connect Cloudflare",
    git: "Connect a git provider",
    project: "Create your first project",
  }[step];
}

function stepDescription(step: StepId) {
  return {
    server: "Everything runs in Docker on this machine.",
    domains: "Give apps a URL the moment they deploy.",
    ssl: "Certificates are issued by Let's Encrypt and renewed for you.",
    cloudflare: "Manage DNS records and certificates from this dashboard.",
    git: "Deploy private repositories and get push-to-deploy.",
    project: "You're almost done.",
  }[step];
}
