"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "@/hooks/use-router";
import { ArrowLeft, ArrowUpRight, ChevronRight, Container, Database, GitBranch, Layers, Lock, Search, Server, ShieldAlert, Sparkles, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input, InputGroup, Textarea } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Card, CardBody, CardFooter, CardHeader, Badge } from "@/components/ui/misc";
import { ServiceIcon } from "@/components/service-icon";
import { TemplateLogo } from "@/components/template-logo";
import { CodeEditor } from "@/components/code-editor";
import { toast } from "@/components/ui/toast";
import { useAction } from "@/hooks/use-action";
import { createAppService, createComposeService, createDatabaseService } from "@/server/actions/services";
import { fetchBranches, fetchRepositories } from "@/server/actions/integrations";
import { cn } from "@/lib/utils";
import { parseEnv } from "@/lib/env";
import { GithubMark } from "@/components/github-mark";
import { PageBody, PageHeader, type Crumb } from "@/components/shell/page-header";
import useSWR from "swr";
import type { DbEngine } from "@/server/services/types";

type Kind = "git" | "image" | "database" | "compose";

export type CatalogTemplate = {
  id: string;
  name: string;
  description: string;
  category: string;
  website: string | null;
  popular: boolean;
  hostAccess: boolean;
  custom: boolean;
  iconUrl: string | null;
  note: string | null;
  vars: { key: string; generate?: string; value?: string; publicUrl?: boolean; publicHost?: boolean; label?: string }[];
};

type ServerOption = { id: string; name: string; host: string; status: string; isLocal: boolean };

const gitProviderNames: Record<string, string> = { github: "GitHub", gitlab: "GitLab", gitea: "Gitea", bitbucket: "Bitbucket" };

type Props = {
  projectId: string;
  environmentId: string;
  /** Servers the organization may deploy to (local first). */
  servers: ServerOption[];
  /** Chosen server; set by the wizard. */
  serverId?: string;
  environmentName: string;
  credentials: { id: string; name: string; provider: string; oauth?: boolean }[];
  nixpacks: boolean;
  initialType: string | null;
  initialTemplate: string | null;
  templates: CatalogTemplate[];
  /** Organization admins can manage templates. */
  canManageTemplates: boolean;
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

const starts: { id: Kind; title: string; body: string; icon: React.ReactNode }[] = [
  { id: "git", title: "Git repository", body: "GitHub, GitLab or any Git URL", icon: <GitBranch /> },
  { id: "image", title: "Docker image", body: "From any registry", icon: <Container /> },
  { id: "compose", title: "Docker Compose", body: "A multi-container stack", icon: <Layers /> },
  { id: "database", title: "Database", body: "Managed, with backups", icon: <Database /> },
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

/** Right-hand guide shown next to every create form. */
function NextSteps() {
  const steps = [
    ["Create", "Serve saves the service. Nothing runs yet."],
    ["Configure", "Add variables, domains, ports and storage if you need them."],
    ["Deploy", "Start it from the service page when you are ready."],
  ];
  return (
    <aside className="flex flex-col gap-3 lg:sticky lg:top-6">
      <Card>
        <CardHeader title="What happens next" />
        <ol className="flex flex-col gap-4 px-5 py-4">
          {steps.map(([title, body], i) => (
            <li key={title} className="flex gap-3">
              <span className="flex size-6 flex-none items-center justify-center rounded-full bg-accent-soft text-xs font-semibold text-accent">{i + 1}</span>
              <div className="flex flex-col">
                <span className="text-[13px] font-medium text-fg">{title}</span>
                <span className="text-xs leading-relaxed text-muted">{body}</span>
              </div>
            </li>
          ))}
        </ol>
      </Card>
    </aside>
  );
}

const stepGrid = "grid grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,1fr)_300px] animate-rise";

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
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      <button type="button" onClick={onBack} className="mb-4 inline-flex items-center gap-1.5 text-[13px] text-muted hover:text-fg">
        <ArrowLeft className="size-3.5" /> All services
      </button>
      <div className={stepGrid}>
        <Card>
          <CardHeader title={title} description={description} />
          <CardBody className="flex flex-col gap-5 py-5">{children}</CardBody>
          <CardFooter className="justify-end">{footer}</CardFooter>
        </Card>
        <NextSteps />
      </div>
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
    success: "Service created. Review the settings, then deploy.",
    onSuccess: (d) => router.push(`/projects/${props.projectId}/services/${d.id}`),
  });

  const filtered = (repos ?? []).filter((r) => r.fullName.toLowerCase().includes(query.toLowerCase())).slice(0, 8);

  return (
    <FormShell
      title="Add a Git repository"
      description="Serve clones the repository, builds an image and deploys it with zero downtime."
      onBack={onBack}
      onSubmit={() =>
        run({
          projectId: props.projectId,
          environmentId: props.environmentId,
          serverId: props.serverId,
          name: name || repoName(repository) || "app",
          source: { type: "git", repository, branch, credentialId: credentialId === "public" ? null : credentialId },
          build: { builder: builder as "auto", rootDir, buildCommand: buildCommand || null, startCommand: startCommand || null },
          port: port ? Number(port) : null,
          envVars: parseEnv(env),
        })
      }
      footer={
        <Button type="submit" variant="primary" size="sm" loading={pending} disabled={!repository.trim()}>
          Create service
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
              description:
                c.provider === "github-app"
                  ? "GitHub App · deploys on push"
                  : c.provider === "ssh"
                    ? "SSH deploy key"
                    : `${gitProviderNames[c.provider] ?? c.provider} ${c.oauth ? "OAuth" : "token"} · deploys on push`,
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
    success: "Service created. Review the settings, then deploy.",
    onSuccess: (d) => router.push(`/projects/${props.projectId}/services/${d.id}`),
  });
  const guessName = image.split("/").pop()?.split(":")[0] ?? "";
  return (
    <FormShell
      title="Add a Docker image"
      description="Serve pulls the image and runs it. Redeploy to pull the newest version of a tag."
      onBack={onBack}
      onSubmit={() =>
        run({
          projectId: props.projectId,
          environmentId: props.environmentId,
          serverId: props.serverId,
          name: name || guessName || "app",
          source: { type: "image", image, registryUsername: priv ? user : null, registryPassword: priv ? pass : null },
          port: port ? Number(port) : null,
          envVars: parseEnv(env),
        })
      }
      footer={
        <Button type="submit" variant="primary" size="sm" loading={pending} disabled={!image.trim()}>
          Create service
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
            <Input type="password" value={pass} onChange={(e) => setPass(e.target.value)} />
          </Field>
        </div>
      )}
      <EnvTextarea value={env} onChange={setEnv} />
    </FormShell>
  );
}

function DatabaseForm({ props, onBack, initialEngine }: { props: Props; onBack: () => void; initialEngine?: DbEngine }) {
  const router = useRouter();
  const [engine, setEngine] = React.useState<DbEngine>(initialEngine ?? "postgres");
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
    success: "Database created. Start it when you are ready.",
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
          serverId: props.serverId,
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
    success: "Stack created. Review the settings, then deploy.",
    onSuccess: (d) => router.push(`/projects/${props.projectId}/services/${d.id}`),
  });
  return (
    <FormShell
      title="Add a Compose stack"
      description="Every compose service joins the private network. Add domains after the first deploy."
      onBack={onBack}
      onSubmit={() =>
        run({
          projectId: props.projectId,
          environmentId: props.environmentId,
          serverId: props.serverId,
          name: name || (mode === "git" ? repoName(repository) : "stack") || "stack",
          mode,
          content,
          path,
          source: mode === "git" ? { repository, branch, credentialId: credentialId === "public" ? null : credentialId } : undefined,
        })
      }
      footer={
        <Button type="submit" variant="primary" size="sm" loading={pending}>
          Create stack
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
          <CodeEditor value={content} onChange={setContent} minRows={14} aria-label="docker-compose.yml" />
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

const POPULAR = "Popular";
const YOURS = "Your templates";

function Catalog({ props, onStart, onTemplate }: { props: Props; onStart: (k: Kind, engine?: DbEngine) => void; onTemplate: (id: string) => void }) {
  const [query, setQuery] = React.useState("");
  const hasCustom = props.templates.some((t) => t.custom);
  const [category, setCategory] = React.useState("All");
  const builtIn = [...new Set(props.templates.filter((t) => !t.custom).map((t) => t.category))];
  const chips = ["All", POPULAR, ...(hasCustom ? [YOURS] : []), ...builtIn];
  const q = query.trim().toLowerCase();
  const list = props.templates
    .filter((t) =>
      q
        ? `${t.name} ${t.description} ${t.category}`.toLowerCase().includes(q)
        : category === POPULAR
          ? t.popular || t.custom
          : category === YOURS
            ? t.custom
            : category === "All" || t.category === category,
    )
    .sort((a, b) => Number(b.custom) - Number(a.custom) || a.name.localeCompare(b.name));

  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-3">
        <h2 className="text-[13px] font-medium text-muted">Start from</h2>
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
          {starts.map((k) => (
            <button
              key={k.id}
              type="button"
              onClick={() => onStart(k.id)}
              className="group flex items-center gap-3 rounded-xl border border-line bg-surface px-3.5 py-3 text-left shadow-sm transition-[border-color,box-shadow] hover:border-line-strong hover:shadow-md"
            >
              <span className="flex size-9 flex-none items-center justify-center rounded-lg bg-accent-soft text-accent [&_svg]:size-[18px]">{k.icon}</span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="text-[14px] font-medium text-fg">{k.title}</span>
                <span className="truncate text-xs text-muted">{k.body}</span>
              </span>
              <ChevronRight className="size-4 flex-none text-faint transition-transform group-hover:translate-x-0.5" />
            </button>
          ))}
        </div>
      </section>

      <section className="flex flex-col gap-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h2 className="text-[15px] font-semibold text-fg">Services</h2>
            <p className="text-[13px] text-muted">Ready-made apps. Review the settings after creating, then deploy.</p>
          </div>
          <div className="flex w-full items-center gap-2 sm:ml-auto sm:w-auto sm:flex-none">
            {/* Fixed-width wrapper: the select must not shrink and cut its label. */}
            <div className="w-40 flex-none sm:w-44">
              <Select
                size="sm"
                value={category}
                onValueChange={setCategory}
                options={chips.map((c) => ({ value: c, label: c === "All" ? "All services" : c }))}
                className="w-full"
              />
            </div>
            <div className="relative min-w-0 flex-1 sm:w-64 sm:flex-none">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-faint" />
              <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={`Search ${props.templates.length} services`} className="pl-8" aria-label="Search services" />
            </div>
          </div>
        </div>
        {list.length ? (
          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
            {list.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => onTemplate(t.id)}
                className="group flex items-start gap-3 rounded-xl border border-line bg-surface p-3.5 text-left shadow-sm transition-[border-color,box-shadow] hover:border-line-strong hover:shadow-md"
              >
                <TemplateLogo id={t.id} name={t.name} iconUrl={t.iconUrl} custom={t.custom} />
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate text-[14px] font-medium text-fg">{t.name}</span>
                    {t.custom && <Badge tone="info">Custom</Badge>}
                    {t.hostAccess && <ShieldAlert className="size-3.5 flex-none text-warn" aria-label="Needs host access" />}
                  </span>
                  <span className="line-clamp-2 text-[12.5px] leading-snug text-muted">{t.description || t.category}</span>
                </span>
              </button>
            ))}
          </div>
        ) : (
          <div className="rounded-xl border border-dashed border-line px-4 py-10 text-center text-[13px] text-muted">
            No service matches “{query}”. Paste its compose file with <button type="button" className="font-medium text-accent" onClick={() => onStart("compose")}>Docker Compose</button>
            {props.canManageTemplates && (
              <>
                {" "}
                or <Link href="/templates/new" className="font-medium text-accent">add a template</Link>
              </>
            )}
            .
          </div>
        )}
      </section>
    </div>
  );
}

function varHint(v: CatalogTemplate["vars"][number]) {
  if (v.publicUrl) return "Follows the service's domain (https://…)";
  if (v.publicHost) return "Follows the service's domain";
  if (v.generate === "password") return "Strong password generated for you";
  if (v.generate) return "Random secret generated for you";
  return null;
}

function TemplateConfigure({ props, template, onBack }: { props: Props; template: CatalogTemplate; onBack: () => void }) {
  const router = useRouter();
  const [name, setName] = React.useState(template.name);
  const [values, setValues] = React.useState<Record<string, string>>(() => Object.fromEntries(template.vars.filter((v) => !v.generate && !v.publicUrl && !v.publicHost).map((v) => [v.key, v.value ?? ""])));
  const [custom, setCustom] = React.useState<Record<string, string>>({});
  const [showGenerated, setShowGenerated] = React.useState(false);
  const editable = template.vars.filter((v) => !v.generate && !v.publicUrl && !v.publicHost);
  const automatic = template.vars.filter((v) => v.generate || v.publicUrl || v.publicHost);
  const { run, pending } = useAction(createComposeService, {
    refresh: false,
    success: "Service created. Review the settings, then deploy.",
    onSuccess: (d) => router.push(`/projects/${props.projectId}/services/${d.id}`),
  });
  const overrides = { ...values, ...Object.fromEntries(Object.entries(custom).filter(([, v]) => v.trim())) };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void run({ projectId: props.projectId, environmentId: props.environmentId, serverId: props.serverId, name: name.trim() || template.name, mode: "inline", template: template.id, vars: overrides });
      }}
    >
      <button type="button" onClick={onBack} className="mb-4 inline-flex items-center gap-1.5 text-[13px] text-muted hover:text-fg">
        <ArrowLeft className="size-3.5" /> All services
      </button>
      <div className={stepGrid}>
      <Card>
        <div className="flex items-start gap-4 border-b border-line px-5 py-5">
          <TemplateLogo id={template.id} name={template.name} iconUrl={template.iconUrl} custom={template.custom} size="lg" />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-[17px] font-semibold text-fg">{template.name}</h2>
              <Badge>{template.custom ? "Custom template" : template.category}</Badge>
            </div>
            <p className="mt-0.5 text-[13px] leading-relaxed text-muted">{template.description}</p>
            {template.website && (
              <a href={template.website} target="_blank" rel="noreferrer" className="mt-1.5 inline-flex items-center gap-1 text-xs text-muted hover:text-accent">
                {template.website.replace(/^https?:\/\//, "").replace(/\/$/, "")} <ArrowUpRight className="size-3" />
              </a>
            )}
          </div>
        </div>
        <CardBody className="flex flex-col gap-5 py-5">
          {template.hostAccess && (
            <div className="flex gap-2.5 rounded-xl border border-warn/30 bg-warn-soft px-3.5 py-3 text-[13px] text-fg-2">
              <ShieldAlert className="mt-0.5 size-4 flex-none text-warn" />
              <span>This service gets access to the server (Docker socket). Only admins of the Root organization can create it.</span>
            </div>
          )}
          {template.note && (
            <div className="flex gap-2.5 rounded-xl bg-surface-2 px-3.5 py-3 text-[13px] leading-relaxed text-fg-2">
              <TriangleAlert className="mt-0.5 size-4 flex-none text-muted" />
              <span>{template.note}</span>
            </div>
          )}
          <Field label="Service name">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={template.name} autoFocus />
          </Field>
          {editable.map((v) => (
            <Field key={v.key} label={v.label ?? v.key} description={v.label ? v.key : undefined}>
              <Input value={values[v.key] ?? ""} onChange={(e) => setValues((s) => ({ ...s, [v.key]: e.target.value }))} className="font-mono text-[13px]" />
            </Field>
          ))}
          {automatic.length > 0 && (
            <div className="flex flex-col gap-2">
              <button type="button" onClick={() => setShowGenerated((s) => !s)} className="flex w-fit items-center gap-1 text-[13px] font-medium text-accent">
                <ChevronRight className={cn("size-3.5 transition-transform", showGenerated && "rotate-90")} />
                {automatic.length} value{automatic.length === 1 ? "" : "s"} set automatically
              </button>
              {showGenerated && (
                <div className="flex animate-rise flex-col divide-y divide-line overflow-hidden rounded-xl border border-line">
                  {automatic.map((v) => (
                    <div key={v.key} className="grid grid-cols-1 gap-2 px-3.5 py-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] sm:items-center">
                      <span className="flex min-w-0 flex-col">
                        <span className="truncate font-mono text-[12.5px] text-fg">{v.key}</span>
                        <span className="text-xs text-muted">{varHint(v)}</span>
                      </span>
                      {v.generate ? (
                        <Input value={custom[v.key] ?? ""} onChange={(e) => setCustom((s) => ({ ...s, [v.key]: e.target.value }))} placeholder="Generate" className="font-mono text-[12.5px]" aria-label={`${v.key} value`} />
                      ) : (
                        <span className="truncate font-mono text-[12px] text-faint">{v.publicUrl ? "${{SERVE_PUBLIC_URL}}" : "${{SERVE_PUBLIC_DOMAIN}}"}</span>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </CardBody>
        <CardFooter className="justify-between gap-3">
          <span className="hidden text-xs text-muted sm:inline">Nothing runs until you deploy.</span>
          <Button type="submit" variant="primary" size="sm" loading={pending}>
            <Sparkles /> Create service
          </Button>
        </CardFooter>
      </Card>
      <NextSteps />
      </div>
    </form>
  );
}

function ServerBar({ servers, value, onChange }: { servers: Props["servers"]; value: string; onChange: (id: string) => void }) {
  const current = servers.find((s) => s.id === value);
  return (
    <div className="flex items-center gap-2">
      {current && current.status !== "ready" && !current.isLocal && <Badge tone="warn">{current.status === "unreachable" ? "Unreachable" : "Not ready"}</Badge>}
      <span className="hidden items-center gap-1.5 text-[13px] text-muted sm:inline-flex">
        <Server className="size-3.5" /> Deploy to
      </span>
      <Select
        size="sm"
        value={value}
        onValueChange={onChange}
        className="w-56"
        options={servers.map((s) => ({
          value: s.id,
          label: s.isLocal ? `${s.name} (this server)` : s.name,
          description: s.isLocal ? "Where Serve runs" : s.host,
          disabled: !s.isLocal && s.status !== "ready" && s.status !== "unreachable",
        }))}
      />
    </div>
  );
}

/** Renders the page header too, so the server picker can sit in its actions. */
export function NewServiceWizard({ header, ...props }: Props & { header: { title: string; description: string; breadcrumbs: Crumb[] } }) {
  const [serverId, setServerId] = React.useState(props.servers[0]?.id ?? "local");
  const p = { ...props, serverId };
  return (
    <>
      <PageHeader {...header} actions={props.servers.length > 1 ? <ServerBar servers={props.servers} value={serverId} onChange={setServerId} /> : undefined} />
      <PageBody>
        <WizardSteps props={p} />
      </PageBody>
    </>
  );
}

type Step = { kind: Kind; engine?: DbEngine } | { template: string } | null;

function WizardSteps({ props }: { props: Props }) {
  const initial: Step =
    props.initialType && starts.some((k) => k.id === props.initialType)
      ? { kind: props.initialType as Kind }
      : props.initialTemplate && props.templates.some((t) => t.id === props.initialTemplate)
        ? { template: props.initialTemplate }
        : null;
  const [step, setStep] = React.useState<Step>(initial);
  const back = () => setStep(null);
  if (!step) return <Catalog props={props} onStart={(kind, engine) => setStep({ kind, engine })} onTemplate={(id) => setStep({ template: id })} />;
  if ("template" in step) return <TemplateConfigure props={props} template={props.templates.find((t) => t.id === step.template)!} onBack={back} />;
  if (step.kind === "git") return <GitForm props={props} onBack={back} />;
  if (step.kind === "image") return <ImageForm props={props} onBack={back} />;
  if (step.kind === "database") return <DatabaseForm props={props} onBack={back} initialEngine={step.engine} />;
  return <ComposeForm props={props} onBack={back} />;
}
