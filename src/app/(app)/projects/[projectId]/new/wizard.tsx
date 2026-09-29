"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, ChevronRight, Container, Database, GitBranch, Layers, Lock, Search, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input, InputGroup, Textarea } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Card, CardBody, CardFooter, CardHeader, Badge } from "@/components/ui/misc";
import { ServiceIcon } from "@/components/service-icon";
import { toast } from "@/components/ui/toast";
import { useAction } from "@/hooks/use-action";
import { createAppService, createComposeService, createDatabaseService } from "@/server/actions/services";
import { fetchBranches, fetchRepositories } from "@/server/actions/integrations";
import { cn } from "@/lib/utils";
import { parseEnv } from "@/lib/env";
import { GithubMark } from "@/components/github-mark";
import useSWR from "swr";
import type { DbEngine } from "@/server/services/types";

type Kind = "git" | "image" | "database" | "compose" | "template";

type Props = {
  projectId: string;
  environmentId: string;
  environmentName: string;
  credentials: { id: string; name: string; provider: string }[];
  nixpacks: boolean;
  initialType: string | null;
  templates: { id: string; name: string; description: string; category: string }[];
  engines: {
    engine: DbEngine;
    label: string;
    versions: string[];
    defaultVersion: string;
    hasUser: boolean;
    hasDatabase: boolean;
    defaultUser: string;
    defaultDatabase: string;
  }[];
};

const kinds: { id: Kind; title: string; body: string; icon: React.ReactNode }[] = [
  { id: "git", title: "Git repository", body: "Build and deploy from GitHub, GitLab or any Git URL. Redeploys on push.", icon: <GitBranch /> },
  { id: "image", title: "Docker image", body: "Run any public or private image from a registry.", icon: <Container /> },
  { id: "database", title: "Database", body: "PostgreSQL, MySQL, MongoDB, Redis and more, with backups.", icon: <Database /> },
  { id: "compose", title: "Docker Compose", body: "Deploy a multi-container stack from a compose file.", icon: <Layers /> },
  { id: "template", title: "One-click service", body: "n8n, Umami, Ghost, Uptime Kuma and other ready-made apps.", icon: <Sparkles /> },
];

function repoName(url: string) {
  return (
    url
      .replace(/\.git$/, "")
      .split(/[/:]/)
      .filter(Boolean)
      .pop() ?? ""
  );
}

function KindPicker({ onPick }: { onPick: (k: Kind) => void }) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {kinds.map((k, i) => (
        <button
          key={k.id}
          type="button"
          onClick={() => onPick(k.id)}
          style={{ animationDelay: `${i * 40}ms` }}
          className="group flex animate-rise flex-col gap-3 rounded-2xl border border-line bg-surface p-5 text-left shadow-sm transition-[border-color,box-shadow,transform] duration-200 hover:-translate-y-0.5 hover:border-line-strong hover:shadow-md"
        >
          <span className="flex size-10 items-center justify-center rounded-xl bg-accent-soft text-accent [&_svg]:size-5">{k.icon}</span>
          <span className="flex flex-col gap-1">
            <span className="flex items-center gap-1 text-[15px] font-semibold text-fg">
              {k.title}
              <ChevronRight className="size-4 text-faint transition-transform group-hover:translate-x-0.5" />
            </span>
            <span className="text-[13px] leading-relaxed text-muted">{k.body}</span>
          </span>
        </button>
      ))}
    </div>
  );
}

function FormShell({
  title,
  description,
  onBack,
  children,
  footer,
  onSubmit,
}: {
  title: string;
  description: string;
  onBack: () => void;
  children: React.ReactNode;
  footer: React.ReactNode;
  onSubmit: () => void;
}) {
  return (
    <form
      className="mx-auto max-w-2xl animate-rise"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      <button type="button" onClick={onBack} className="mb-4 inline-flex items-center gap-1.5 text-[13px] text-muted hover:text-fg">
        <ArrowLeft className="size-3.5" /> All service types
      </button>
      <Card>
        <CardHeader title={title} description={description} />
        <CardBody className="flex flex-col gap-5 py-5">{children}</CardBody>
        <CardFooter className="justify-end">{footer}</CardFooter>
      </Card>
    </form>
  );
}

function EnvTextarea({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const count = parseEnv(value).length;
  return (
    <Field label="Environment variables" optional description={count ? `${count} variable${count === 1 ? "" : "s"} detected. Paste a .env file here.` : "Paste the contents of a .env file. You can edit variables later."}>
      <Textarea value={value} onChange={(e) => onChange(e.target.value)} rows={4} placeholder={"DATABASE_URL=${{postgres.DATABASE_URL}}\nNODE_ENV=production"} className="font-mono text-[12.5px]" spellCheck={false} />
    </Field>
  );
}

function GitForm({ props, onBack }: { props: Props; onBack: () => void }) {
  const router = useRouter();
  const preferred = props.credentials.find((c) => c.provider === "github-app") ?? props.credentials.find((c) => c.provider !== "ssh");
  const [credentialId, setCredentialId] = React.useState<string>(preferred?.id ?? "public");
  const [query, setQuery] = React.useState("");
  const [repository, setRepository] = React.useState("");
  const [branch, setBranch] = React.useState("main");
  const [branches, setBranches] = React.useState<string[]>([]);
  const [name, setName] = React.useState("");
  const [builder, setBuilder] = React.useState("auto");
  const [rootDir, setRootDir] = React.useState("/");
  const [port, setPort] = React.useState("");
  const [env, setEnv] = React.useState("");
  const [advanced, setAdvanced] = React.useState(false);
  const [buildCommand, setBuildCommand] = React.useState("");
  const [startCommand, setStartCommand] = React.useState("");
  const cred = props.credentials.find((c) => c.id === credentialId);
  const canList = cred && cred.provider !== "ssh";

  const { data: repoData } = useSWR(canList ? ["repos", credentialId] : null, async () => {
    const res = await fetchRepositories(credentialId);
    if (!res.ok) {
      toast.error(res.error);
      return [];
    }
    return res.data;
  });
  const repos = canList ? (repoData ?? null) : null;

  const loadBranches = React.useCallback(
    async (repo: string) => {
      if (!repo.trim()) return;
      const res = await fetchBranches(repo, credentialId === "public" ? null : credentialId);
      if (res.ok) {
        setBranches(res.data);
        if (res.data.length && !res.data.includes(branch)) setBranch(res.data.includes("main") ? "main" : res.data.includes("master") ? "master" : res.data[0]);
      }
    },
    [credentialId, branch],
  );

  const { run, pending } = useAction(createAppService, {
    refresh: false,
    success: "Service created. Deploying…",
    onSuccess: (d) => router.push(`/projects/${props.projectId}/services/${d.id}`),
  });

  const filtered = (repos ?? []).filter((r) => r.fullName.toLowerCase().includes(query.toLowerCase())).slice(0, 8);

  return (
    <FormShell
      title="Deploy a Git repository"
      description="Serve clones the repository, builds an image and deploys it with zero downtime."
      onBack={onBack}
      onSubmit={() =>
        run({
          projectId: props.projectId,
          environmentId: props.environmentId,
          name: name || repoName(repository) || "app",
          source: { type: "git", repository, branch, credentialId: credentialId === "public" ? null : credentialId },
          build: { builder: builder as "auto", rootDir, buildCommand: buildCommand || null, startCommand: startCommand || null },
          port: port ? Number(port) : null,
          envVars: parseEnv(env),
          deploy: true,
        })
      }
      footer={
        <Button type="submit" variant="primary" size="sm" loading={pending} disabled={!repository.trim()}>
          Deploy
        </Button>
      }
    >
      <Field label="Access">
        <Select
          value={credentialId}
          onValueChange={setCredentialId}
          options={[
            { value: "public", label: "Public repository", description: "No credentials needed" },
            ...props.credentials.map((c) => ({
              value: c.id,
              label: c.name,
              description: c.provider === "github-app" ? "GitHub App · deploys on push" : c.provider === "ssh" ? "SSH deploy key" : `${c.provider} token`,
            })),
          ]}
        />
      </Field>
      {!props.credentials.some((c) => c.provider === "github-app") && (
        <a href="/integrations/git" className="-mt-2 flex items-center gap-3 rounded-xl border border-line bg-surface-2 px-3.5 py-3 text-[13px] transition-colors hover:border-line-strong">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-fg text-bg">
            <GithubMark className="size-4" />
          </span>
          <span className="flex flex-1 flex-col">
            <span className="font-medium text-fg">Connect GitHub</span>
            <span className="text-xs text-muted">Browse private repositories and deploy automatically on every push.</span>
          </span>
          <ChevronRight className="size-4 text-faint" />
        </a>
      )}

      {canList && (
        <Field label="Repository">
          <div className="overflow-hidden rounded-xl border border-line">
            <div className="flex items-center gap-2 border-b border-line bg-surface-2 px-3">
              <Search className="size-3.5 text-faint" />
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search repositories" className="h-9 flex-1 bg-transparent text-sm outline-none placeholder:text-faint" />
            </div>
            <div className="max-h-64 divide-y divide-line overflow-y-auto scrollbar-thin">
              {repos === null && <div className="px-3 py-3 text-[13px] text-muted">Loading repositories…</div>}
              {repos?.length === 0 && <div className="px-3 py-3 text-[13px] text-muted">No repositories found.</div>}
              {filtered.map((r) => (
                <button
                  key={r.fullName}
                  type="button"
                  onClick={() => {
                    setRepository(r.cloneUrl);
                    setBranch(r.defaultBranch);
                    setName((n) => n || repoName(r.fullName));
                    void loadBranches(r.cloneUrl);
                  }}
                  className={cn(
                    "flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-[13px] transition-colors hover:bg-hover",
                    repository === r.cloneUrl && "bg-accent-soft",
                  )}
                >
                  <GitBranch className="size-3.5 text-faint" />
                  <span className="flex-1 truncate text-fg-2">{r.fullName}</span>
                  {r.private && <Lock className="size-3 text-faint" />}
                  {repository === r.cloneUrl && <Badge tone="info">Selected</Badge>}
                </button>
              ))}
            </div>
          </div>
        </Field>
      )}

      {!canList && (
        <Field label="Repository URL" description="HTTPS or SSH URL, or owner/repo for GitHub.">
          <Input
            value={repository}
            onChange={(e) => setRepository(e.target.value)}
            onBlur={() => {
              setName((n) => n || repoName(repository));
              void loadBranches(repository);
            }}
            placeholder="https://github.com/vercel/next.js"
            required
            className="font-mono text-[13px]"
          />
        </Field>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Branch">
          {branches.length ? (
            <Select value={branch} onValueChange={setBranch} options={branches.map((b) => ({ value: b, label: b }))} />
          ) : (
            <Input value={branch} onChange={(e) => setBranch(e.target.value)} required className="font-mono text-[13px]" />
          )}
        </Field>
        <Field label="Service name">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={repoName(repository) || "web"} />
        </Field>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Builder">
          <Select
            value={builder}
            onValueChange={setBuilder}
            options={[
              { value: "auto", label: "Automatic", description: "Dockerfile if present, otherwise detect" },
              { value: "dockerfile", label: "Dockerfile" },
              { value: "nixpacks", label: "Nixpacks", description: props.nixpacks ? "Installed" : "Not installed", disabled: !props.nixpacks },
              { value: "static", label: "Static site", description: "Served by nginx" },
            ]}
          />
        </Field>
        <Field label="Port" optional description="Detected automatically when empty.">
          <Input value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, ""))} placeholder="3000" inputMode="numeric" />
        </Field>
      </div>

      <button type="button" onClick={() => setAdvanced((a) => !a)} className="flex w-fit items-center gap-1 text-[13px] font-medium text-accent">
        <ChevronRight className={cn("size-3.5 transition-transform", advanced && "rotate-90")} /> Build options
      </button>
      {advanced && (
        <div className="grid grid-cols-1 animate-rise gap-4 sm:grid-cols-2">
          <Field label="Root directory">
            <InputGroup prefix="/">
              <Input value={rootDir.replace(/^\//, "")} onChange={(e) => setRootDir(`/${e.target.value.replace(/^\//, "")}`)} placeholder="apps/web" />
            </InputGroup>
          </Field>
          <Field label="Build command" optional>
            <Input value={buildCommand} onChange={(e) => setBuildCommand(e.target.value)} placeholder="npm run build" className="font-mono text-[13px]" />
          </Field>
          <Field label="Start command" optional className="sm:col-span-2">
            <Input value={startCommand} onChange={(e) => setStartCommand(e.target.value)} placeholder="npm start" className="font-mono text-[13px]" />
          </Field>
        </div>
      )}

      <EnvTextarea value={env} onChange={setEnv} />
    </FormShell>
  );
}

function ImageForm({ props, onBack }: { props: Props; onBack: () => void }) {
  const router = useRouter();
  const [image, setImage] = React.useState("");
  const [name, setName] = React.useState("");
  const [port, setPort] = React.useState("");
  const [env, setEnv] = React.useState("");
  const [priv, setPriv] = React.useState(false);
  const [user, setUser] = React.useState("");
  const [pass, setPass] = React.useState("");
  const { run, pending } = useAction(createAppService, {
    refresh: false,
    success: "Service created. Deploying…",
    onSuccess: (d) => router.push(`/projects/${props.projectId}/services/${d.id}`),
  });
  const guessName = image.split("/").pop()?.split(":")[0] ?? "";
  return (
    <FormShell
      title="Deploy a Docker image"
      description="Serve pulls the image and runs it. Redeploy to pull the newest version of a tag."
      onBack={onBack}
      onSubmit={() =>
        run({
          projectId: props.projectId,
          environmentId: props.environmentId,
          name: name || guessName || "app",
          source: { type: "image", image, registryUsername: priv ? user : null, registryPassword: priv ? pass : null },
          port: port ? Number(port) : null,
          envVars: parseEnv(env),
        })
      }
      footer={
        <Button type="submit" variant="primary" size="sm" loading={pending} disabled={!image.trim()}>
          Deploy
        </Button>
      }
    >
      <Field label="Image" description="For example nginx:alpine, ghcr.io/owner/app:latest">
        <Input value={image} onChange={(e) => setImage(e.target.value)} placeholder="traefik/whoami:latest" required autoFocus className="font-mono text-[13px]" />
      </Field>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Service name">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={guessName || "web"} />
        </Field>
        <Field label="Port" optional description="Uses the image's exposed port when empty.">
          <Input value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, ""))} placeholder="80" inputMode="numeric" />
        </Field>
      </div>
      <label className="flex items-center gap-2 text-[13px] text-fg-2">
        <input type="checkbox" checked={priv} onChange={(e) => setPriv(e.target.checked)} className="accent-[var(--accent)]" />
        This image is in a private registry
      </label>
      {priv && (
        <div className="grid grid-cols-1 animate-rise gap-4 sm:grid-cols-2">
          <Field label="Username">
            <Input value={user} onChange={(e) => setUser(e.target.value)} autoComplete="off" />
          </Field>
          <Field label="Password or token">
            <Input type="password" value={pass} onChange={(e) => setPass(e.target.value)} autoComplete="new-password" />
          </Field>
        </div>
      )}
      <EnvTextarea value={env} onChange={setEnv} />
    </FormShell>
  );
}

function DatabaseForm({ props, onBack }: { props: Props; onBack: () => void }) {
  const router = useRouter();
  const [engine, setEngine] = React.useState<DbEngine>("postgres");
  const info = props.engines.find((e) => e.engine === engine)!;
  const [version, setVersion] = React.useState(info.defaultVersion);
  const pickEngine = (e: DbEngine) => {
    setEngine(e);
    setVersion(props.engines.find((x) => x.engine === e)!.defaultVersion);
  };
  const [name, setName] = React.useState("");
  const [username, setUsername] = React.useState("");
  const [database, setDatabase] = React.useState("");
  const { run, pending } = useAction(createDatabaseService, {
    refresh: false,
    success: "Database created. Starting…",
    onSuccess: (d) => router.push(`/projects/${props.projectId}/services/${d.id}`),
  });
  return (
    <FormShell
      title="Add a database"
      description="A strong password is generated for you. Other services reach it on the private network."
      onBack={onBack}
      onSubmit={() =>
        run({
          projectId: props.projectId,
          environmentId: props.environmentId,
          name: name || info.label.toLowerCase(),
          engine,
          version,
          username: username || undefined,
          database: database || undefined,
        })
      }
      footer={
        <Button type="submit" variant="primary" size="sm" loading={pending}>
          Create database
        </Button>
      }
    >
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {props.engines.map((e) => (
          <button
            key={e.engine}
            type="button"
            onClick={() => pickEngine(e.engine)}
            className={cn(
              "flex flex-col items-center gap-2 rounded-xl border p-3 text-[13px] font-medium transition-all",
              engine === e.engine ? "border-accent bg-accent-soft text-fg shadow-[0_0_0_1px_var(--accent)]" : "border-line text-fg-2 hover:border-line-strong hover:bg-hover/50",
            )}
          >
            <ServiceIcon type="database" engine={e.engine} size="sm" />
            {e.label}
          </button>
        ))}
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={info.label.toLowerCase()} />
        </Field>
        <Field label="Version">
          <Select value={version} onValueChange={setVersion} options={info.versions.map((v) => ({ value: v, label: v }))} />
        </Field>
        {info.hasUser && (
          <Field label="Username" optional>
            <Input value={username} onChange={(e) => setUsername(e.target.value)} placeholder={info.defaultUser} />
          </Field>
        )}
        {info.hasDatabase && (
          <Field label="Database name" optional>
            <Input value={database} onChange={(e) => setDatabase(e.target.value)} placeholder={info.defaultDatabase} />
          </Field>
        )}
      </div>
    </FormShell>
  );
}

const sampleCompose = `services:
  web:
    image: nginx:alpine
    volumes:
      - web-data:/usr/share/nginx/html
volumes:
  web-data:
`;

function ComposeForm({ props, onBack }: { props: Props; onBack: () => void }) {
  const router = useRouter();
  const [mode, setMode] = React.useState<"inline" | "git">("inline");
  const [name, setName] = React.useState("");
  const [content, setContent] = React.useState(sampleCompose);
  const [repository, setRepository] = React.useState("");
  const [branch, setBranch] = React.useState("main");
  const [path, setPath] = React.useState("docker-compose.yml");
  const [credentialId, setCredentialId] = React.useState("public");
  const { run, pending } = useAction(createComposeService, {
    refresh: false,
    success: "Stack created. Deploying…",
    onSuccess: (d) => router.push(`/projects/${props.projectId}/services/${d.id}`),
  });
  return (
    <FormShell
      title="Deploy a Compose stack"
      description="Every compose service joins the private network. Add domains after the first deploy."
      onBack={onBack}
      onSubmit={() =>
        run({
          projectId: props.projectId,
          environmentId: props.environmentId,
          name: name || (mode === "git" ? repoName(repository) : "stack") || "stack",
          mode,
          content,
          path,
          source: mode === "git" ? { repository, branch, credentialId: credentialId === "public" ? null : credentialId } : undefined,
        })
      }
      footer={
        <Button type="submit" variant="primary" size="sm" loading={pending}>
          Deploy stack
        </Button>
      }
    >
      <div className="grid grid-cols-2 gap-1 rounded-xl bg-sunken p-1">
        {(["inline", "git"] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => setMode(m)}
            className={cn("h-8 rounded-lg text-[13px] font-medium transition-all", mode === m ? "bg-surface text-fg shadow-sm" : "text-muted hover:text-fg")}
          >
            {m === "inline" ? "Paste compose file" : "From Git repository"}
          </button>
        ))}
      </div>
      <Field label="Name">
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="stack" />
      </Field>
      {mode === "inline" ? (
        <Field label="docker-compose.yml">
          <Textarea value={content} onChange={(e) => setContent(e.target.value)} rows={14} className="font-mono text-[12.5px] leading-relaxed" spellCheck={false} />
        </Field>
      ) : (
        <>
          <Field label="Access">
            <Select
              value={credentialId}
              onValueChange={setCredentialId}
              options={[{ value: "public", label: "Public repository" }, ...props.credentials.map((c) => ({ value: c.id, label: c.name }))]}
            />
          </Field>
          <Field label="Repository URL">
            <Input value={repository} onChange={(e) => setRepository(e.target.value)} placeholder="https://github.com/owner/stack" required className="font-mono text-[13px]" />
          </Field>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Branch">
              <Input value={branch} onChange={(e) => setBranch(e.target.value)} className="font-mono text-[13px]" />
            </Field>
            <Field label="Compose file path">
              <Input value={path} onChange={(e) => setPath(e.target.value)} className="font-mono text-[13px]" />
            </Field>
          </div>
        </>
      )}
    </FormShell>
  );
}

function TemplatePicker({ props, onBack }: { props: Props; onBack: () => void }) {
  const router = useRouter();
  const [query, setQuery] = React.useState("");
  const [category, setCategory] = React.useState("All");
  const [creating, setCreating] = React.useState<string | null>(null);
  const categories = ["All", ...new Set(props.templates.map((t) => t.category))];
  const list = props.templates.filter(
    (t) => (category === "All" || t.category === category) && `${t.name} ${t.description}`.toLowerCase().includes(query.toLowerCase()),
  );
  const { run } = useAction(createComposeService, {
    refresh: false,
    success: "Service created. Deploying…",
    onSuccess: (d) => router.push(`/projects/${props.projectId}/services/${d.id}`),
  });

  return (
    <div className="animate-rise">
      <button type="button" onClick={onBack} className="mb-4 inline-flex items-center gap-1.5 text-[13px] text-muted hover:text-fg">
        <ArrowLeft className="size-3.5" /> All service types
      </button>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="relative w-full max-w-xs">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-faint" />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search services" className="pl-8" autoFocus />
        </div>
        <div className="flex flex-wrap gap-1.5">
          {categories.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setCategory(c)}
              className={cn(
                "h-7 rounded-full px-3 text-xs font-medium transition-colors",
                category === c ? "bg-fg text-bg" : "bg-surface text-muted ring-1 ring-line hover:text-fg",
              )}
            >
              {c}
            </button>
          ))}
        </div>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {list.map((t) => (
          <button
            key={t.id}
            type="button"
            disabled={!!creating}
            onClick={async () => {
              setCreating(t.id);
              await run({ projectId: props.projectId, environmentId: props.environmentId, name: t.name, mode: "inline", template: t.id });
              setCreating(null);
            }}
            className="group flex items-start gap-3 rounded-2xl border border-line bg-surface p-4 text-left shadow-sm transition-[border-color,box-shadow,transform] duration-200 hover:-translate-y-0.5 hover:border-line-strong hover:shadow-md disabled:opacity-60"
          >
            <ServiceIcon type="compose" icon={t.id} />
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="flex items-center gap-2 text-[14px] font-semibold text-fg">
                {t.name}
                {creating === t.id && <span className="text-xs font-normal text-muted">Creating…</span>}
              </span>
              <span className="text-[13px] leading-relaxed text-muted">{t.description}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

export function NewServiceWizard(props: Props) {
  const initial = kinds.some((k) => k.id === props.initialType) ? (props.initialType as Kind) : null;
  const [kind, setKind] = React.useState<Kind | null>(initial);
  const back = () => setKind(null);
  if (!kind) return <KindPicker onPick={setKind} />;
  if (kind === "git") return <GitForm props={props} onBack={back} />;
  if (kind === "image") return <ImageForm props={props} onBack={back} />;
  if (kind === "database") return <DatabaseForm props={props} onBack={back} />;
  if (kind === "compose") return <ComposeForm props={props} onBack={back} />;
  return <TemplatePicker props={props} onBack={back} />;
}

