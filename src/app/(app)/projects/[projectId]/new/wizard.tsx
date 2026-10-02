"use client";

import { typedServiceName } from "@/lib/service-name";
import { composeVarSuffix } from "@/lib/refs";
import * as React from "react";
import Link from "next/link";
import { useRouter } from "@/hooks/use-router";
import {
  ArrowLeft,
  ArrowUpRight,
  ChevronRight,
  Container,
  Database,
  FileCode,
  GitBranch,
  Globe,
  KeyRound,
  Layers,
  Lock,
  Plus,
  Search,
  Server,
  ShieldAlert,
  Sparkles,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input, InputGroup, Textarea } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Card, CardBody, CardFooter, CardHeader, Badge } from "@/components/ui/misc";
import { ServiceIcon } from "@/components/service-icon";
import { ImagePicker, type PickerRegistry, type RegistryChoice } from "@/components/image-picker";
import { ReloadTemplates } from "@/components/reload-templates";
import { TemplateLogo } from "@/components/template-logo";
import { CodeEditor } from "@/components/code-editor";
import { useAction, showError } from "@/hooks/use-action";
import { createAppService, createComposeService, createDatabaseService } from "@/server/actions/services";
import { fetchBranches, fetchRepositories } from "@/server/actions/integrations";
import { cn } from "@/lib/utils";
import { parseEnv } from "@/lib/env";
import { GithubMark } from "@/components/github-mark";
import { PageBody, PageHeader, type Crumb } from "@/components/shell/page-header";
import useSWR from "swr";
import type { DbEngine } from "@/server/services/types";
import { NixpacksHint } from "@/components/nixpacks-hint";
import { toVolumes, type VolumeRow, volumeName, volumeRowsIssue } from "./volume-rows";

type Kind = "git" | "image" | "dockerfile" | "database" | "compose";
/** How a Git repository is reached: by URL, with an SSH deploy key, or through a connected account. */
type GitAccess = "public" | "key" | "account";

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
  vars: { key: string; generate?: string; value?: string; publicUrl?: boolean; publicHost?: boolean; serviceUrl?: string; serviceHost?: string; label?: string }[];
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
  /** Saved container registries: the Docker image form lists their images and pulls with their login. */
  registries: PickerRegistry[];
  nixpacks: boolean;
  initialType: string | null;
  /** Server picked in "Deploy to" when the page opens, e.g. the server of the app a link came from. */
  initialServerId?: string | null;
  initialTemplate: string | null;
  /** Git form filled in from a link (an existing app's "deploy its compose file"). */
  initialGit?: { repository: string; branch: string; credentialId: string | null; builder: string | null; rootDir?: string | null } | null;
  templates: CatalogTemplate[];
  /** Data of databases deleted with their volume kept: a new database can start on it. */
  kept?: { id: string; name: string; engine: DbEngine; version: string; serverId: string; serverName: string; createdAt: string }[];
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
    /** Source of a case-insensitive pattern matching the engine's images (see EngineInfo.imagePattern). */
    imagePattern: string;
  }[];
};

const starts: { id: Kind; key: string; access?: GitAccess; title: string; body: string; icon: React.ReactNode }[] = [
  { id: "git", key: "git-account", access: "account", title: "Git provider", body: "GitHub, GitLab, Gitea or Bitbucket. Deploys on every push.", icon: <GithubMark /> },
  { id: "git", key: "git-public", access: "public", title: "Public repository", body: "Any public Git URL. No credentials needed.", icon: <Globe /> },
  { id: "git", key: "git-key", access: "key", title: "Private repository", body: "Over SSH with a deploy key. You set the URL and branch.", icon: <KeyRound /> },
  { id: "image", key: "image", title: "Docker image", body: "A ready-made image from Docker Hub or any registry.", icon: <Container /> },
  { id: "dockerfile", key: "dockerfile", title: "Dockerfile", body: "Paste a Dockerfile and Serve builds it; no repository needed.", icon: <FileCode /> },
  { id: "compose", key: "compose", title: "Docker Compose", body: "A multi-container stack from a compose file.", icon: <Layers /> },
  { id: "database", key: "database", title: "Database", body: "PostgreSQL, MySQL, Redis and more, with backups.", icon: <Database /> },
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
    ["Create", "The service is saved. Nothing runs yet."],
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
  description: React.ReactNode;
  onBack: () => void;
  children: React.ReactNode;
  footer: React.ReactNode;
  onSubmit: () => void;
}) {
  return (
    <form
      method="post"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      <BackRow onBack={onBack} />
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
    <Field
      label="Environment variables"
      optional
      description={count ? `${count} variable${count === 1 ? "" : "s"} detected. Paste a .env file here.` : "Paste the contents of a .env file. You can edit variables later."}
    >
      <Textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={4}
        placeholder={"DATABASE_URL=${{postgres.DATABASE_URL}}\nNODE_ENV=production"}
        className="font-mono text-[12.5px]"
        spellCheck={false}
      />
    </Field>
  );
}

function GitForm({ props, onBack, access }: { props: Props; onBack: () => void; access?: GitAccess }) {
  const router = useRouter();
  // The kind of access picked on the first page narrows the accounts offered; a link from an app keeps them all.
  const usable = props.credentials.filter((c) => (access === "key" ? c.provider === "ssh" : access === "account" ? c.provider !== "ssh" : !access));
  const preferred = usable.find((c) => c.provider === "github-app") ?? usable[0];
  const initial = props.initialGit;
  const [credentialId, setCredentialId] = React.useState<string>(
    initial
      ? initial.credentialId && props.credentials.some((c) => c.id === initial.credentialId)
        ? initial.credentialId
        : "public"
      : access === "public"
        ? "public"
        : access
          ? (preferred?.id ?? "")
          : (preferred?.id ?? "public"),
  );
  const missing = access === "key" || access === "account" ? !usable.length : false;
  const [query, setQuery] = React.useState("");
  const [repository, setRepository] = React.useState(initial?.repository ?? "");
  const [branch, setBranch] = React.useState(initial?.branch ?? "main");
  const [branches, setBranches] = React.useState<string[]>([]);
  const [name, setName] = React.useState("");
  const [builder, setBuilder] = React.useState(initial?.builder === "compose" ? "compose" : "auto");
  /** "compose": the repository's compose file, deployed as a stack instead of one built image. */
  const compose = builder === "compose";
  // From an app in a folder of the repository: its compose file is likely next to it.
  const [composePath, setComposePath] = React.useState(() => {
    const dir = (initial?.rootDir ?? "").replace(/^\/+|\/+$/g, "");
    return dir && !dir.split("/").includes("..") ? `${dir}/docker-compose.yml` : "docker-compose.yml";
  });
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
      showError(res.error);
      return [];
    }
    return res.data;
  });
  const repos = canList ? (repoData ?? null) : null;

  const loadBranches = React.useCallback(
    // `preferred`: the branch just picked with the repository; `branch` is still the old one here.
    async (repo: string, preferred = branch) => {
      if (!repo.trim()) return;
      const res = await fetchBranches(repo, credentialId === "public" ? null : credentialId);
      if (res.ok) {
        setBranches(res.data);
        if (res.data.length && !res.data.includes(preferred)) setBranch(res.data.includes("main") ? "main" : res.data.includes("master") ? "master" : res.data[0]);
      }
    },
    [credentialId, branch],
  );

  const { run, pending } = useAction(createAppService, {
    refresh: false,
    onSuccess: (d) => router.push(`/projects/${props.projectId}/services/${d.id}`),
  });
  const stack = useAction(createComposeService, {
    refresh: false,
    onSuccess: (d) => router.push(`/projects/${props.projectId}/services/${d.id}`),
  });

  const filtered = (repos ?? []).filter((r) => r.fullName.toLowerCase().includes(query.toLowerCase())).slice(0, 8);
  const listed = repos?.find((r) => r.cloneUrl === repository) ?? null;
  // A repository from a link stays chosen even when the list is loading or does not include it.
  const selectedRepo =
    listed ??
    (repository && repository === initial?.repository
      ? { fullName: repository.replace(/^https?:\/\/[^/]+\//, "").replace(/\.git$/, ""), private: false, defaultBranch: null as string | null }
      : null);

  return (
    <FormShell
      title={
        access === "public"
          ? "Add a public repository"
          : access === "key"
            ? "Add a private repository"
            : access === "account"
              ? "Add a repository from your account"
              : "Add a Git repository"
      }
      description={<>The server clones the repository, {compose ? "then runs every service of its compose file." : "builds an image and deploys it with zero downtime."}</>}
      onBack={onBack}
      onSubmit={() =>
        compose
          ? stack.run({
              projectId: props.projectId,
              environmentId: props.environmentId,
              serverId: props.serverId,
              name: name || repoName(repository) || "stack",
              mode: "git",
              path: composePath.trim().replace(/^\/+/, "") || "docker-compose.yml",
              source: { repository, branch, credentialId: credentialId === "public" ? null : credentialId },
              envVars: parseEnv(env),
            })
          : run({
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
        <Button type="submit" variant="primary" size="sm" loading={pending || stack.pending} disabled={!repository.trim() || missing || !credentialId}>
          {compose ? "Create stack" : "Create service"}
        </Button>
      }
    >
      {access !== "public" && !missing && (
        <Field label={access === "key" ? "Deploy key" : access === "account" ? "Account" : "Access"}>
          <Select
            value={credentialId}
            onValueChange={setCredentialId}
            options={[
              ...(access ? [] : [{ value: "public", label: "Public repository", description: "No credentials needed" }]),
              ...usable.map((c) => ({
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
      )}
      {missing && (
        <a
          href="/integrations/git"
          className="flex items-center gap-3 rounded-xl border border-line bg-surface-2 px-3.5 py-3 text-[13px] transition-colors hover:border-line-strong"
        >
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-fg text-bg">
            {access === "key" ? <KeyRound className="size-4" /> : <GithubMark className="size-4" />}
          </span>
          <span className="flex flex-1 flex-col">
            <span className="font-medium text-fg">{access === "key" ? "Add a deploy key first" : "Connect a Git account first"}</span>
            <span className="text-xs text-muted">
              {access === "key"
                ? "In Git providers, create an SSH key and add its public key to the repository as a deploy key."
                : "In Git providers, connect GitHub, GitLab, Gitea or Bitbucket to browse your repositories."}
            </span>
          </span>
          <ChevronRight className="size-4 text-faint" />
        </a>
      )}
      {!access && !props.credentials.some((c) => c.provider === "github-app") && (
        <a
          href="/integrations/git"
          className="-mt-2 flex items-center gap-3 rounded-xl border border-line bg-surface-2 px-3.5 py-3 text-[13px] transition-colors hover:border-line-strong"
        >
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
          {selectedRepo ? (
            <div className="flex items-center gap-3 rounded-xl border border-accent/40 bg-accent-soft/30 px-3.5 py-3">
              <span className="flex size-9 flex-none items-center justify-center rounded-lg bg-surface ring-1 ring-line">
                <GitBranch className="size-4 text-muted" />
              </span>
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="flex items-center gap-1.5 text-[14px] font-medium text-fg">
                  <span className="truncate">{selectedRepo.fullName}</span>
                  {selectedRepo.private && <Lock className="size-3 flex-none text-faint" />}
                </span>
                {selectedRepo.defaultBranch && <span className="text-xs text-muted">Default branch {selectedRepo.defaultBranch}</span>}
              </div>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => {
                  // Forget the choice, and the fields filled from it.
                  setName((n) => (n === repoName(selectedRepo.fullName) ? "" : n));
                  setRepository("");
                  setBranch("main");
                  setBranches([]);
                  setQuery("");
                }}
              >
                Change
              </Button>
            </div>
          ) : (
            <div className="overflow-hidden rounded-xl border border-line">
              <div className="flex items-center gap-2 border-b border-line bg-surface-2 px-3">
                <Search className="size-3.5 text-faint" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search repositories"
                  className="h-9 flex-1 bg-transparent text-sm outline-none placeholder:text-faint"
                />
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
                      void loadBranches(r.cloneUrl, r.defaultBranch);
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
          )}
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
            placeholder={access === "key" ? "git@github.com:owner/repo.git" : "https://github.com/vercel/next.js"}
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
          <Input value={name} onChange={(e) => setName(typedServiceName(e.target.value))} placeholder={repoName(repository) || "web"} />
        </Field>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Builder" description={builder === "nixpacks" && !props.nixpacks ? <NixpacksHint /> : undefined}>
          <Select
            value={builder}
            onValueChange={setBuilder}
            options={[
              { value: "auto", label: "Automatic", description: "Dockerfile if present, otherwise detect" },
              { value: "dockerfile", label: "Dockerfile" },
              { value: "compose", label: "Docker Compose", description: "Run the repository's compose file" },
              { value: "nixpacks", label: "Nixpacks", description: props.nixpacks ? "Installed" : "Not installed yet" },
              { value: "static", label: "Static site", description: "Served by nginx" },
            ]}
          />
        </Field>
        {compose ? (
          <Field label="Compose file" description="Path in the repository. compose.yaml and similar names are found too.">
            <Input value={composePath} onChange={(e) => setComposePath(e.target.value)} placeholder="docker-compose.yml" className="font-mono text-[13px]" />
          </Field>
        ) : (
          <Field label="Port" optional description="Detected automatically when empty.">
            <Input value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, ""))} placeholder="3000" inputMode="numeric" />
          </Field>
        )}
      </div>
      {compose && (
        <p className="-mt-2 text-xs text-muted">
          Every service in the file runs as its own container, and each one is shown on the service page. Add domains after the first deploy.
        </p>
      )}

      {!compose && (
        <button type="button" onClick={() => setAdvanced((a) => !a)} className="flex w-fit items-center gap-1 text-[13px] font-medium text-accent">
          <ChevronRight className={cn("size-3.5 transition-transform", advanced && "rotate-90")} /> Build options
        </button>
      )}
      {advanced && !compose && (
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

function ImageForm({ props, onBack, onDatabase }: { props: Props; onBack: () => void; onDatabase: (engine: DbEngine) => void }) {
  const router = useRouter();
  const [image, setImage] = React.useState("");
  const [name, setName] = React.useState("");
  const [port, setPort] = React.useState("");
  const [env, setEnv] = React.useState("");
  const [registry, setRegistry] = React.useState<RegistryChoice>("");
  const priv = registry === "manual";
  const savedRegistry = props.registries.some((r) => r.id === registry) ? registry : null;
  const [user, setUser] = React.useState("");
  const [pass, setPass] = React.useState("");
  const [storage, setStorage] = React.useState(false);
  const [volumes, setVolumes] = React.useState<VolumeRow[]>([{ mountPath: "", name: "" }]);
  const volumesIssue = storage ? volumeRowsIssue(volumes) : null;
  const { run, pending } = useAction(createAppService, {
    refresh: false,
    onSuccess: (d) => router.push(`/projects/${props.projectId}/services/${d.id}`),
  });
  const guessName = image.split("/").pop()?.split(":")[0] ?? "";
  // A database image: the Database type runs the same engine with backups, credentials and upgrades.
  const dbEngine = image.trim() ? props.engines.find((e) => new RegExp(e.imagePattern, "i").test(image.trim())) : undefined;
  return (
    <FormShell
      title="Add a Docker image"
      description={<>The server pulls the image and runs it. Redeploy to pull the newest version of a tag.</>}
      onBack={onBack}
      onSubmit={() =>
        run({
          projectId: props.projectId,
          environmentId: props.environmentId,
          serverId: props.serverId,
          name: name || guessName || "app",
          source: { type: "image", image: image.trim(), registryId: savedRegistry, registryUsername: priv ? user : null, registryPassword: priv ? pass : null },
          port: port ? Number(port) : null,
          envVars: parseEnv(env),
          volumes: storage ? toVolumes(volumes) : [],
        })
      }
      footer={
        <Button type="submit" variant="primary" size="sm" loading={pending} disabled={!image.trim() || !!volumesIssue}>
          Create service
        </Button>
      }
    >
      <ImagePicker
        registries={props.registries}
        registry={registry}
        image={image}
        onChange={(r, i) => {
          setRegistry(r);
          setImage(i);
        }}
        autoFocus
      />
      {dbEngine && (
        <div className="flex animate-rise flex-col gap-3 rounded-xl border border-accent/40 bg-accent-soft/30 px-3.5 py-3 sm:flex-row sm:items-center">
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <ServiceIcon type="database" engine={dbEngine.engine} size="sm" />
            <p className="min-w-0 text-[13px] text-fg-2">For databases, the Database type adds backups, credentials and upgrades.</p>
          </div>
          <Button type="button" size="sm" className="w-full flex-none sm:w-auto" onClick={() => onDatabase(dbEngine.engine)}>
            <Database /> Use {dbEngine.label}
          </Button>
        </div>
      )}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Service name">
          <Input value={name} onChange={(e) => setName(typedServiceName(e.target.value))} placeholder={guessName || "web"} />
        </Field>
        <Field label="Port" optional description="Uses the image's exposed port when empty.">
          <Input value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, ""))} placeholder="80" inputMode="numeric" />
        </Field>
      </div>
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
      <StorageFields open={storage} onOpenChange={setStorage} volumes={volumes} onChange={setVolumes} issue={volumesIssue} />
      <EnvTextarea value={env} onChange={setEnv} />
    </FormShell>
  );
}

/** Persistent storage rows of the create forms: named volumes at container paths. */
function StorageFields({
  open,
  onOpenChange,
  volumes,
  onChange,
  issue,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  volumes: VolumeRow[];
  onChange: React.Dispatch<React.SetStateAction<VolumeRow[]>>;
  issue: string | null;
}) {
  const setVolume = (i: number, patch: Partial<VolumeRow>) => onChange((all) => all.map((v, j) => (j === i ? { ...v, ...patch } : v)));
  return (
    <>
      <button type="button" onClick={() => onOpenChange(!open)} className="flex w-fit items-center gap-1 text-[13px] font-medium text-accent" aria-expanded={open}>
        <ChevronRight className={cn("size-3.5 transition-transform", open && "rotate-90")} /> Persistent storage
      </button>
      {open && (
        <div className="flex animate-rise flex-col gap-3">
          <p className="text-[12.5px] text-muted">Paths the image stores data in are kept automatically.</p>
          {volumes.map((v, i) => (
            <div key={i} className="flex items-end gap-2">
              <div className="grid min-w-0 flex-1 grid-cols-1 gap-2 sm:grid-cols-2">
                <Field label={i === 0 ? "Container path" : undefined}>
                  <Input
                    value={v.mountPath}
                    onChange={(e) => setVolume(i, { mountPath: e.target.value })}
                    placeholder="/data"
                    aria-label="Container path"
                    className="font-mono text-[13px]"
                  />
                </Field>
                <Field label={i === 0 ? "Volume name" : undefined} optional={i === 0}>
                  <Input
                    value={v.name}
                    onChange={(e) => setVolume(i, { name: e.target.value })}
                    placeholder={v.mountPath.trim() ? volumeName(v.mountPath.trim()) : "data"}
                    aria-label="Volume name"
                    className="font-mono text-[13px]"
                  />
                </Field>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-9 flex-none"
                aria-label="Remove"
                onClick={() => onChange((all) => (all.length > 1 ? all.filter((_, j) => j !== i) : [{ mountPath: "", name: "" }]))}
              >
                <Trash2 />
              </Button>
            </div>
          ))}
          <div className="flex flex-wrap items-center gap-3">
            <Button type="button" size="sm" onClick={() => onChange((all) => [...all, { mountPath: "", name: "" }])}>
              <Plus /> Add path
            </Button>
            {issue && <span className="text-xs text-bad">{issue}</span>}
          </div>
        </div>
      )}
    </>
  );
}

function DockerfileForm({ props, onBack }: { props: Props; onBack: () => void }) {
  const router = useRouter();
  const [content, setContent] = React.useState(sampleDockerfile);
  const [name, setName] = React.useState("");
  const [port, setPort] = React.useState("");
  const [env, setEnv] = React.useState("");
  const [storage, setStorage] = React.useState(false);
  const [volumes, setVolumes] = React.useState<VolumeRow[]>([{ mountPath: "", name: "" }]);
  const volumesIssue = storage ? volumeRowsIssue(volumes) : null;
  const { run, pending } = useAction(createAppService, {
    refresh: false,
    onSuccess: (d) => router.push(`/projects/${props.projectId}/services/${d.id}`),
  });
  return (
    <FormShell
      title="Build a Dockerfile"
      description={<>The server builds the Dockerfile on every deploy and runs the image. Build-time variables are passed as build arguments.</>}
      onBack={onBack}
      onSubmit={() =>
        run({
          projectId: props.projectId,
          environmentId: props.environmentId,
          serverId: props.serverId,
          name: name || "app",
          source: { type: "dockerfile", content },
          port: port ? Number(port) : null,
          envVars: parseEnv(env),
          volumes: storage ? toVolumes(volumes) : [],
        })
      }
      footer={
        <Button type="submit" variant="primary" size="sm" loading={pending} disabled={!content.trim() || !!volumesIssue}>
          Create service
        </Button>
      }
    >
      <Field label="Dockerfile" description="The build has no other files: COPY and ADD of local files fail. Fetch what you need with RUN, or use a repository instead.">
        <CodeEditor value={content} onChange={setContent} minRows={12} aria-label="Dockerfile" />
      </Field>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Service name">
          <Input value={name} onChange={(e) => setName(typedServiceName(e.target.value))} placeholder="app" />
        </Field>
        <Field label="Port" optional description="Uses the port the image exposes when empty.">
          <Input value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, ""))} placeholder="8080" inputMode="numeric" />
        </Field>
      </div>
      <StorageFields open={storage} onOpenChange={setStorage} volumes={volumes} onChange={setVolumes} issue={volumesIssue} />
      <EnvTextarea value={env} onChange={setEnv} />
    </FormShell>
  );
}

const sampleDockerfile = `FROM nginx:alpine
RUN echo '<h1>Hello from Serve</h1>' > /usr/share/nginx/html/index.html
EXPOSE 80
`;

function DatabaseForm({ props, onBack, initialEngine }: { props: Props; onBack: () => void; initialEngine?: DbEngine }) {
  const router = useRouter();
  const [engine, setEngine] = React.useState<DbEngine>(initialEngine ?? "postgres");
  const info = props.engines.find((e) => e.engine === engine)!;
  const [version, setVersion] = React.useState(info.defaultVersion);
  // The defaults are filled in, not only hinted: what you see is what gets made.
  const [name, setName] = React.useState(info.label.toLowerCase());
  const [username, setUsername] = React.useState(info.defaultUser);
  const [database, setDatabase] = React.useState(info.defaultDatabase);
  const pickEngine = (e: DbEngine) => {
    const next = props.engines.find((x) => x.engine === e)!;
    // Values still at the old engine's defaults follow the new engine.
    if (name === info.label.toLowerCase()) setName(next.label.toLowerCase());
    if (username === info.defaultUser) setUsername(next.defaultUser);
    if (database === info.defaultDatabase) setDatabase(next.defaultDatabase);
    setEngine(e);
    setVersion(next.defaultVersion);
  };
  const kept = props.kept ?? [];
  const [from, setFrom] = React.useState("new");
  const keptRow = kept.find((k) => k.id === from) ?? null;
  const keptInfo = keptRow ? props.engines.find((e) => e.engine === keptRow.engine) : null;
  const { run, pending } = useAction(createDatabaseService, {
    refresh: false,
    onSuccess: (d) => router.push(`/projects/${props.projectId}/services/${d.id}`),
  });
  return (
    <FormShell
      title="Add a database"
      description={
        keptRow ? "It starts on the kept data, with the user and password it had." : "A strong password is generated for you. Other services reach it on the private network."
      }
      onBack={onBack}
      onSubmit={() =>
        run(
          keptRow
            ? {
                projectId: props.projectId,
                environmentId: props.environmentId,
                name: name || keptRow.name,
                engine: keptRow.engine,
                keptId: keptRow.id,
              }
            : {
                projectId: props.projectId,
                environmentId: props.environmentId,
                serverId: props.serverId,
                name: name || info.label.toLowerCase(),
                engine,
                version,
                username: username || undefined,
                database: database || undefined,
              },
        )
      }
      footer={
        <Button type="submit" variant="primary" size="sm" loading={pending}>
          Create database
        </Button>
      }
    >
      {kept.length > 0 && (
        <Field label="Start from">
          <Select
            value={from}
            onValueChange={(v) => {
              setFrom(v);
              const k = kept.find((x) => x.id === v);
              setName(k ? k.name : info.label.toLowerCase());
            }}
            options={[
              { value: "new", label: "A new, empty database" },
              ...kept.map((k) => ({
                value: k.id,
                label: `Kept data of ${k.name}`,
                description: `${props.engines.find((e) => e.engine === k.engine)?.label ?? k.engine} ${k.version} · ${k.serverName} · deleted ${new Date(k.createdAt).toLocaleDateString()}`,
              })),
            ]}
          />
        </Field>
      )}
      {keptRow ? (
        <>
          <div className="flex items-center gap-3 rounded-xl border border-line px-3.5 py-3">
            <ServiceIcon type="database" engine={keptRow.engine} size="sm" />
            <div className="flex min-w-0 flex-col">
              <span className="text-[13px] font-medium text-fg">
                {keptInfo?.label ?? keptRow.engine} {keptRow.version}
              </span>
              <span className="text-xs text-muted">Runs on {keptRow.serverName}, where its data is.</span>
            </div>
          </div>
          <Field label="Name">
            <Input value={name} onChange={(e) => setName(typedServiceName(e.target.value))} />
          </Field>
        </>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {props.engines.map((e) => (
              <button
                key={e.engine}
                type="button"
                onClick={() => pickEngine(e.engine)}
                className={cn(
                  "flex flex-col items-center gap-2 rounded-xl border p-3 text-[13px] font-medium transition-all",
                  engine === e.engine
                    ? "border-accent bg-accent-soft text-fg shadow-[0_0_0_1px_var(--accent)]"
                    : "border-line text-fg-2 hover:border-line-strong hover:bg-hover/50",
                )}
              >
                <ServiceIcon type="database" engine={e.engine} size="sm" />
                {e.label}
              </button>
            ))}
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Name">
              <Input value={name} onChange={(e) => setName(typedServiceName(e.target.value))} required />
            </Field>
            <Field label="Version">
              <Select value={version} onValueChange={setVersion} options={info.versions.map((v) => ({ value: v, label: v }))} />
            </Field>
            {info.hasUser && (
              <Field label="Username">
                <Input value={username} onChange={(e) => setUsername(e.target.value)} required />
              </Field>
            )}
            {info.hasDatabase && (
              <Field label="Database name">
                <Input value={database} onChange={(e) => setDatabase(e.target.value)} required />
              </Field>
            )}
          </div>
        </>
      )}
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
        <Input value={name} onChange={(e) => setName(typedServiceName(e.target.value))} placeholder="stack" />
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

const ENGINE_BLURB: Partial<Record<DbEngine, string>> = {
  postgres: "Relational database with strong SQL support and extensions.",
  mysql: "Relational database for web and general-purpose apps.",
  mariadb: "Relational database, a drop-in replacement for MySQL.",
  mongodb: "Document database that stores JSON-like records.",
  redis: "In-memory key-value store for caches, queues and sessions.",
  valkey: "Open source, Redis-compatible in-memory store.",
  clickhouse: "Column database for fast analytics over large data.",
};

function SectionTitle({ title, description }: { title: string; description: string }) {
  return (
    <div>
      <h2 className="text-[15px] font-semibold text-fg">{title}</h2>
      <p className="text-[13px] text-muted">{description}</p>
    </div>
  );
}

function StartCard({ icon, title, body, onClick }: { icon: React.ReactNode; title: string; body: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex items-start gap-4 rounded-2xl border border-line bg-surface p-5 text-left shadow-sm transition-[border-color,box-shadow] hover:border-line-strong hover:shadow-md"
    >
      {icon}
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="text-[15px] font-semibold text-fg">{title}</span>
        <span className="text-[13px] leading-snug text-muted">{body}</span>
      </span>
      <ChevronRight className="mt-0.5 size-4 flex-none self-center text-faint transition-transform group-hover:translate-x-0.5" />
    </button>
  );
}

function Catalog({ props, onStart, onTemplate }: { props: Props; onStart: (k: Kind, engine?: DbEngine, access?: GitAccess) => void; onTemplate: (id: string) => void }) {
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
        <SectionTitle title="Applications" description="Your own code or a ready-made image." />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {starts
            .filter((k) => k.id !== "database")
            .map((k) => (
              <StartCard
                key={k.key}
                icon={<span className="flex size-11 flex-none items-center justify-center rounded-xl bg-accent-soft text-accent [&_svg]:size-[22px]">{k.icon}</span>}
                title={k.title}
                body={k.body}
                onClick={() => onStart(k.id, undefined, k.access)}
              />
            ))}
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <SectionTitle title="Databases" description="Managed for you: credentials, backups and upgrades." />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {props.engines.map((e) => (
            <StartCard
              key={e.engine}
              icon={<ServiceIcon type="database" engine={e.engine} size="md" />}
              title={e.label}
              body={ENGINE_BLURB[e.engine] ?? "A managed database."}
              onClick={() => onStart("database", e.engine)}
            />
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
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={`Search ${props.templates.length} services`}
                className="pl-8"
                aria-label="Search services"
              />
            </div>
            <ReloadTemplates className="size-9" />
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
            No service matches “{query}”. Paste its compose file with{" "}
            <button type="button" className="font-medium text-accent" onClick={() => onStart("compose")}>
              Docker Compose
            </button>
            {props.canManageTemplates && (
              <>
                {" "}
                or{" "}
                <Link href="/templates/new" className="font-medium text-accent">
                  add a template
                </Link>
              </>
            )}
            .
          </div>
        )}
      </section>
    </div>
  );
}

/** Filled in by Serve: generated, or a domain reference. */
const isAutomatic = (v: CatalogTemplate["vars"][number]) => !!(v.generate || v.publicUrl || v.publicHost || v.serviceUrl || v.serviceHost);

function varHint(v: CatalogTemplate["vars"][number]) {
  if (v.publicUrl) return "Follows the service's domain (https://…)";
  if (v.publicHost) return "Follows the service's domain";
  if (v.serviceUrl || v.serviceHost) return `Follows the domain of ${v.serviceUrl ?? v.serviceHost}`;
  if (v.generate === "password") return "Strong password generated for you";
  if (v.generate) return "Random secret generated for you";
  return null;
}

function TemplateConfigure({ props, template, onBack }: { props: Props; template: CatalogTemplate; onBack: () => void }) {
  const router = useRouter();
  const [name, setName] = React.useState(template.name);
  const [values, setValues] = React.useState<Record<string, string>>(() => Object.fromEntries(template.vars.filter((v) => !isAutomatic(v)).map((v) => [v.key, v.value ?? ""])));
  const [custom, setCustom] = React.useState<Record<string, string>>({});
  const [showGenerated, setShowGenerated] = React.useState(false);
  const editable = template.vars.filter((v) => !isAutomatic(v));
  const automatic = template.vars.filter(isAutomatic);
  const { run, pending } = useAction(createComposeService, {
    refresh: false,
    onSuccess: (d) => router.push(`/projects/${props.projectId}/services/${d.id}`),
  });
  const overrides = { ...values, ...Object.fromEntries(Object.entries(custom).filter(([, v]) => v.trim())) };

  return (
    <form
      method="post"
      onSubmit={(e) => {
        e.preventDefault();
        void run({
          projectId: props.projectId,
          environmentId: props.environmentId,
          serverId: props.serverId,
          name: name.trim() || template.name,
          mode: "inline",
          template: template.id,
          vars: overrides,
        });
      }}
    >
      <BackRow onBack={onBack} />
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
              <Input value={name} onChange={(e) => setName(typedServiceName(e.target.value))} placeholder={template.name} autoFocus />
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
                          <Input
                            value={custom[v.key] ?? ""}
                            onChange={(e) => setCustom((s) => ({ ...s, [v.key]: e.target.value }))}
                            placeholder="Generate"
                            className="font-mono text-[12.5px]"
                            aria-label={`${v.key} value`}
                          />
                        ) : (
                          <span className="truncate font-mono text-[12px] text-faint">
                            {v.publicUrl
                              ? "${{SERVE_PUBLIC_URL}}"
                              : v.serviceUrl
                                ? `\${{SERVE_PUBLIC_URL_${composeVarSuffix(v.serviceUrl)}}}`
                                : v.serviceHost
                                  ? `\${{SERVE_PUBLIC_DOMAIN_${composeVarSuffix(v.serviceHost)}}}`
                                  : "${{SERVE_PUBLIC_DOMAIN}}"}
                          </span>
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

const ServerBarContext = React.createContext<React.ReactNode>(null);

/** "All services" on the left, the server picker on the right. */
function BackRow({ onBack }: { onBack: () => void }) {
  const serverBar = React.useContext(ServerBarContext);
  return (
    // Same columns as the form below, so the picker lines up with the form's right edge.
    <div className={cn(stepGrid, "mb-4")}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <button type="button" onClick={onBack} className="inline-flex items-center gap-1.5 text-[13px] text-muted hover:text-fg">
          <ArrowLeft className="size-3.5" /> All services
        </button>
        {serverBar}
      </div>
    </div>
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
          description: s.isLocal ? "Where this dashboard runs" : s.host,
          disabled: !s.isLocal && s.status !== "ready" && s.status !== "unreachable",
        }))}
      />
    </div>
  );
}

/** Renders the page header too, so the server picker can sit in its actions. */
export function NewServiceWizard({ header, ...props }: Props & { header: { title?: string; description?: string; breadcrumbs: Crumb[] } }) {
  const [serverId, setServerId] = React.useState(props.initialServerId ?? props.servers[0]?.id ?? "local");
  const [step, setStep] = React.useState<Step>(() => initialStep(props));
  const p = { ...props, serverId };
  return (
    <>
      <PageHeader {...header} />
      <PageBody>
        {/* Where it deploys only matters once a kind of service is chosen: it sits next to the way back. */}
        <ServerBarContext.Provider value={props.servers.length > 1 ? <ServerBar servers={props.servers} value={serverId} onChange={setServerId} /> : null}>
          <WizardSteps props={p} step={step} setStep={setStep} />
        </ServerBarContext.Provider>
      </PageBody>
    </>
  );
}

type Step = { kind: Kind; engine?: DbEngine; access?: GitAccess } | { template: string } | null;

function initialStep(props: Props): Step {
  return props.initialType && starts.some((k) => k.id === props.initialType)
    ? { kind: props.initialType as Kind }
    : props.initialTemplate && props.templates.some((t) => t.id === props.initialTemplate)
      ? { template: props.initialTemplate }
      : null;
}

function WizardSteps({ props, step, setStep }: { props: Props; step: Step; setStep: (s: Step) => void }) {
  const back = () => setStep(null);
  if (!step) return <Catalog props={props} onStart={(kind, engine, access) => setStep({ kind, engine, access })} onTemplate={(id) => setStep({ template: id })} />;
  if ("template" in step) return <TemplateConfigure props={props} template={props.templates.find((t) => t.id === step.template)!} onBack={back} />;
  if (step.kind === "git") return <GitForm props={props} onBack={back} access={step.access} />;
  if (step.kind === "image") return <ImageForm props={props} onBack={back} onDatabase={(engine) => setStep({ kind: "database", engine })} />;
  if (step.kind === "dockerfile") return <DockerfileForm props={props} onBack={back} />;
  if (step.kind === "database") return <DatabaseForm props={props} onBack={back} initialEngine={step.engine} />;
  return <ComposeForm props={props} onBack={back} />;
}
