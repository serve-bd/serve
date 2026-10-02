"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "@/hooks/use-router";
import { ChevronRight, FileCode2, Lock, Pencil, Plus, RefreshCw, RotateCcw, Trash2, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardBody, CardFooter, CardHeader, EmptyState, TimeAgo, Copyable } from "@/components/ui/misc";
import { Field } from "@/components/ui/field";
import { Input, Textarea } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { SwitchRow } from "@/components/ui/switch";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { useConfirm } from "@/components/ui/confirm";
import { toast } from "@/components/ui/toast";
import { CodeView } from "@/components/code-view";
import { useAction } from "@/hooks/use-action";
import { getSiteFile, reloadProxyNow } from "@/server/actions/server-proxy";
import { deleteProxyFile, saveProxyContainer, saveProxyDefaults, saveProxyFile } from "@/server/actions/proxy-kind";
import type { ProxyDefaults, ProxyFile, RunningKind } from "@/server/proxy/config";
import { cn, formatBytes } from "@/lib/utils";
import { MAX_REDIRECT_URL, redirectUrlError } from "@/lib/unknown-redirect";

export type ManagedFile = { file: string; kind: "main" | "dashboard" | "service" | "custom" | "other"; label: string; href: string | null; size: number; updatedAt: string };

const LABEL: Record<RunningKind, string> = { nginx: "nginx", caddy: "Caddy", traefik: "Traefik" };

const CUSTOM_HELP: Record<RunningKind, { hint: string; where: React.ReactNode; placeholder: string; name: string }> = {
  nginx: {
    hint: "Name ends in .conf",
    name: "my-rules.conf",
    where: (
      <>
        Included inside nginx&apos;s <code className="font-mono text-[12px]">http</code> block, before the sites. Add <code className="font-mono text-[12px]">server</code> blocks,
        maps or rate limit zones.
      </>
    ),
    placeholder: 'server {\n    listen 80;\n    server_name status.example.com;\n    return 200 "ok";\n}',
  },
  caddy: {
    hint: "Name ends in .caddy",
    name: "my-site.caddy",
    where: "Imported at the end of the Caddyfile. Add sites or snippets; global options go in the settings above.",
    placeholder: 'status.example.com {\n\trespond "ok"\n}',
  },
  traefik: {
    hint: "Name ends in .yaml or .yml",
    name: "my-routes.yaml",
    where: "Loaded by Traefik's file provider next to the generated files. Define http routers, middlewares and services.",
    placeholder: "http:\n  routers:\n    status:\n      rule: Host(`status.example.com`)\n      service: noop@internal",
  },
};

/** Managed (read-only) and custom configuration files of the server's proxy. */
export function DynamicConfigsCard({
  serverId,
  kind,
  managed,
  custom,
  disabled,
  running,
}: {
  serverId: string;
  kind: RunningKind;
  managed: ManagedFile[];
  custom: ProxyFile[];
  disabled: boolean;
  running: boolean;
}) {
  const router = useRouter();
  const confirm = useConfirm();
  const [editing, setEditing] = React.useState<{ original: string | null; name: string; content: string } | null>(null);
  const reload = useAction(() => reloadProxyNow(serverId), { success: "Proxy reloaded" });
  const remove = useAction((name: string) => deleteProxyFile(serverId, kind, name), { success: "File deleted" });
  const help = CUSTOM_HELP[kind];

  return (
    <Card>
      <CardHeader
        title="Dynamic configurations"
        description={`Files ${LABEL[kind]} loads on this server. The managed ones are generated; add your own below.`}
        actions={
          <Button size="sm" onClick={() => reload.run()} loading={reload.pending} disabled={disabled || !running}>
            <RefreshCw /> Reload
          </Button>
        }
      />
      <div className="divide-y divide-line">
        {managed.length === 0 && <EmptyState icon={<FileCode2 />} title="No files yet" description="Files appear when the proxy runs and services get domains." />}
        {managed.map((f) => (
          <ManagedRow key={f.file} serverId={serverId} file={f} />
        ))}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line bg-surface-2/40 px-5 py-3">
        <div className="min-w-0">
          <p className="text-[13px] font-medium text-fg">Custom files</p>
          <p className="text-xs text-muted">{help.where}</p>
        </div>
        <Button size="sm" onClick={() => setEditing({ original: null, name: "", content: "" })} disabled={disabled}>
          <Plus /> Add
        </Button>
      </div>
      {custom.length > 0 && (
        <div className="divide-y divide-line border-t border-line">
          {custom.map((f) => (
            <div key={f.name} className="flex items-center gap-3 px-5 py-3">
              <span className="flex size-8 flex-none items-center justify-center rounded-lg border border-line bg-surface-2 text-muted">
                <FileCode2 className="size-4" />
              </span>
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="flex min-w-0 items-center gap-2 text-[13px] font-medium text-fg">
                  <span className="truncate font-mono">{f.name}</span>
                  <Badge tone="info">Custom</Badge>
                </span>
                <span className="truncate text-[11.5px] text-muted">
                  {f.content.split("\n").length} lines · {formatBytes(new Blob([f.content]).size)}
                </span>
              </div>
              <Button size="xs" onClick={() => setEditing({ original: f.name, name: f.name, content: f.content })} disabled={disabled}>
                <Pencil /> Edit
              </Button>
              <Button
                size="xs"
                variant="danger-ghost"
                disabled={disabled}
                loading={remove.pending}
                aria-label={`Delete ${f.name}`}
                onClick={async () => {
                  if (
                    await confirm({
                      title: `Delete ${f.name}?`,
                      description: `${LABEL[kind]} reloads without this file. Anything it configures stops working.`,
                      confirmLabel: "Delete",
                      danger: true,
                    })
                  )
                    await remove.run(f.name);
                }}
              >
                <Trash2 />
              </Button>
            </div>
          ))}
        </div>
      )}
      <FileDialog
        serverId={serverId}
        kind={kind}
        value={editing}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          router.refresh();
        }}
      />
    </Card>
  );
}

function ManagedRow({ serverId, file }: { serverId: string; file: ManagedFile }) {
  const [open, setOpen] = React.useState(false);
  const [content, setContent] = React.useState<string | null>(null);
  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (next) {
      const res = await getSiteFile(serverId, file.file);
      setContent(res.ok ? (res.data ?? "") : res.error);
    }
  };
  return (
    <div>
      <div className="flex items-center gap-3 px-5 py-3">
        <button type="button" onClick={toggle} aria-expanded={open} className="flex min-w-0 flex-1 items-center gap-3 text-left">
          <ChevronRight className={cn("size-4 flex-none text-muted transition-transform", open && "rotate-90")} />
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="flex min-w-0 items-center gap-2 text-[13px] font-medium text-fg">
              <span className="truncate">{file.label}</span>
              <Badge tone="neutral">
                <Lock /> Managed
              </Badge>
              {file.kind === "dashboard" && <Badge tone="accent">Dashboard</Badge>}
            </span>
            <span className="truncate font-mono text-[11.5px] text-muted">
              {file.file.replace(/^main\//, "")} · {formatBytes(file.size)} · <TimeAgo date={file.updatedAt} />
            </span>
          </div>
        </button>
        {file.href && (
          <Link href={file.href} className="flex-none text-xs text-muted hover:text-fg hover:underline">
            Service
          </Link>
        )}
      </div>
      {open && <div className="px-5 pb-4">{content === null ? <p className="text-xs text-muted">Loading…</p> : <CodeView code={content} maxHeight="420px" />}</div>}
    </div>
  );
}

function FileDialog({
  serverId,
  kind,
  value,
  onClose,
  onSaved,
}: {
  serverId: string;
  kind: RunningKind;
  value: { original: string | null; name: string; content: string } | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  return (
    <Dialog open={!!value} onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="xl">
        {value && <FileForm key={value.original ?? "new"} serverId={serverId} kind={kind} value={value} onClose={onClose} onSaved={onSaved} />}
      </DialogContent>
    </Dialog>
  );
}

function FileForm({
  serverId,
  kind,
  value,
  onClose,
  onSaved,
}: {
  serverId: string;
  kind: RunningKind;
  value: { original: string | null; name: string; content: string };
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = React.useState(value.name);
  const [content, setContent] = React.useState(value.content);
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);
  const help = CUSTOM_HELP[kind];

  const save = async () => {
    setPending(true);
    setError(null);
    const res = await saveProxyFile(serverId, kind, { originalName: value?.original ?? null, name, content });
    setPending(false);
    if (!res.ok) return setError(res.error);
    toast.success(`${name} applied`);
    onSaved();
  };

  return (
    <>
      <DialogHeader
        title={value?.original ? `Edit ${value.original}` : "Add a configuration file"}
        description={`The file is written, checked with ${LABEL[kind]} and reloaded. A rejected file is rolled back.`}
      />
      <DialogBody className="flex flex-col gap-4">
        <Field label="File name" description={help.hint}>
          <Input value={name} onChange={(e) => setName(e.target.value.toLowerCase())} placeholder={help.name} className="font-mono" autoFocus={!value?.original} />
        </Field>
        <Field label="Content" description="127.0.0.1:PORT and localhost:PORT reach this machine's own ports, also apps that listen on 127.0.0.1 only.">
          <Textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            rows={16}
            spellCheck={false}
            placeholder={help.placeholder}
            className="font-mono text-[12.5px] leading-relaxed"
          />
        </Field>
        {error && <ErrorBox message={error} />}
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" size="sm" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" size="sm" onClick={save} loading={pending} disabled={!name.trim()}>
          Test and apply
        </Button>
      </DialogFooter>
    </>
  );
}

export function ErrorBox({ message }: { message: string }) {
  return (
    <Copyable value={message}>
      <div className="flex items-start gap-2.5 rounded-xl border border-bad/15 bg-bad-soft/60 py-3 pr-10 pl-3.5">
        <TriangleAlert className="mt-0.5 size-4 flex-none text-bad" />
        <pre className="min-w-0 flex-1 font-mono text-[11.5px] leading-relaxed break-words whitespace-pre-wrap text-fg-2">{message}</pre>
      </div>
    </Copyable>
  );
}

type UnknownHosts = "page" | "redirect" | "off";

const unknownOf = (d: Required<ProxyDefaults>): UnknownHosts => (!d.catchAll ? "off" : d.unknownRedirect ? "redirect" : "page");

const UNKNOWN_OPTIONS: { value: UnknownHosts; label: string }[] = [
  { value: "page", label: "Built-in 404 page" },
  { value: "redirect", label: "Redirect to a URL" },
  { value: "off", label: "Off — my config files handle them" },
];

const UNKNOWN_HELP: Record<UnknownHosts, string> = {
  page: "Hostnames with no domain on this server get the built-in 404 page.",
  redirect: "Hostnames with no domain on this server get a temporary (302) redirect to this exact URL.",
  off: "Nothing is added for hostnames with no domain on this server.",
};

/** Serve's catch-all, 503 page and HTTPS redirects, each of which can be handed to custom files. */
export function BuiltInDefaultsCard({ serverId, kind, initial, disabled }: { serverId: string; kind: RunningKind; initial: Required<ProxyDefaults>; disabled: boolean }) {
  const router = useRouter();
  const [value, setValue] = React.useState(initial);
  const [unknown, setUnknown] = React.useState<UnknownHosts>(unknownOf(initial));
  const [url, setUrl] = React.useState(initial.unknownRedirect ?? "");
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);
  const next: Required<ProxyDefaults> = { ...value, catchAll: unknown !== "off", unknownRedirect: unknown === "redirect" ? url.trim() : null };
  const dirty = JSON.stringify(next) !== JSON.stringify(initial);
  const urlError = unknown === "redirect" ? redirectUrlError(url.trim()) : null;
  const off = <span className="text-warn"> Off: your custom files must handle this.</span>;
  const discard = () => {
    setValue(initial);
    setUnknown(unknownOf(initial));
    setUrl(initial.unknownRedirect ?? "");
    setError(null);
  };
  const save = async () => {
    setPending(true);
    setError(null);
    const res = await saveProxyDefaults(serverId, kind, next);
    setPending(false);
    if (!res.ok) return setError(res.error);
    toast.success("Built-in defaults applied");
    router.refresh();
  };
  return (
    <Card>
      <CardHeader title="Built-in defaults" description={<>What is added automatically. Turn one off to handle it in a custom file instead.</>} />
      <CardBody className="flex flex-col gap-3 py-5">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field
            label="Unknown hostnames"
            description={
              <>
                {UNKNOWN_HELP[unknown]}
                {unknown === "off" && off}
              </>
            }
          >
            <Select value={unknown} onValueChange={(x) => setUnknown(x as UnknownHosts)} options={UNKNOWN_OPTIONS} disabled={disabled} aria-label="Unknown hostnames" />
          </Field>
          {unknown === "redirect" && (
            <Field label="Redirect to" error={url.trim() ? urlError : null}>
              <Input
                type="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://example.com"
                maxLength={MAX_REDIRECT_URL}
                spellCheck={false}
                autoCapitalize="off"
                className="font-mono text-[12.5px]"
                disabled={disabled}
              />
            </Field>
          )}
        </div>
        <SwitchRow
          title="Unavailable page"
          description={<>Stopped or unreachable services answer with the built-in 503 page.{!value.unavailablePage && off}</>}
          checked={value.unavailablePage}
          onCheckedChange={(x) => setValue({ ...value, unavailablePage: x })}
          disabled={disabled}
        />
        {kind !== "nginx" && (
          <SwitchRow
            title="HTTP to HTTPS redirect"
            description={
              <>
                {kind === "caddy" ? "Caddy redirects HTTP to HTTPS for every HTTPS domain (automatic HTTPS)." : "Traefik redirects HTTP to HTTPS for domains that force HTTPS."}
                {!value.httpsRedirect && off}
              </>
            }
            checked={value.httpsRedirect}
            onCheckedChange={(x) => setValue({ ...value, httpsRedirect: x })}
            disabled={disabled}
          />
        )}
        {error && <ErrorBox message={error} />}
      </CardBody>
      <CardFooter>
        <span className="truncate text-xs text-muted">{dirty ? "Unsaved changes" : "Validated by the proxy before it applies"}</span>
        <div className="flex flex-none gap-2">
          {dirty && (
            <Button variant="ghost" size="sm" onClick={discard}>
              Discard
            </Button>
          )}
          <Button variant="primary" size="sm" onClick={save} disabled={!dirty || disabled || !!urlError} loading={pending}>
            Test and apply
          </Button>
        </div>
      </CardFooter>
    </Card>
  );
}

export type ContainerView = { image: string; args: string[]; env: { name: string; hasValue: boolean }[]; volumes: string[]; ports: string[]; customized: boolean };

const clean = (items: string[]) => items.map((l) => l.trim()).filter(Boolean);

/** A list of single-line values (arguments, ports, volumes) with add and remove. */
function ListEditor({
  title,
  description,
  placeholder,
  items,
  onChange,
  disabled,
}: {
  title: string;
  description: string;
  placeholder: string;
  items: string[];
  onChange: (items: string[]) => void;
  disabled: boolean;
}) {
  return (
    <div className="flex flex-col gap-2 px-5 py-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[13px] font-medium text-fg">{title}</p>
          <p className="text-xs text-muted">{description}</p>
        </div>
        <Button size="xs" onClick={() => onChange([...items, ""])} disabled={disabled}>
          <Plus /> Add
        </Button>
      </div>
      {items.length === 0 && <p className="text-xs text-faint">None</p>}
      {items.map((item, i) => (
        <div key={i} className="flex items-center gap-2">
          <Input
            value={item}
            onChange={(e) => onChange(items.map((x, j) => (j === i ? e.target.value : x)))}
            placeholder={placeholder}
            className="font-mono text-[12.5px]"
            aria-label={`${title} ${i + 1}`}
            autoFocus={item === "" && i === items.length - 1}
            disabled={disabled}
          />
          <Button size="xs" variant="danger-ghost" aria-label={`Remove from ${title.toLowerCase()}`} onClick={() => onChange(items.filter((_, j) => j !== i))} disabled={disabled}>
            <Trash2 />
          </Button>
        </div>
      ))}
    </div>
  );
}

/** Image, arguments, environment, volumes and extra ports of the proxy container. */
export function ProxyContainerCard({
  serverId,
  kind,
  initial,
  defaultImage,
  definition,
  disabled,
}: {
  serverId: string;
  kind: RunningKind;
  initial: ContainerView;
  defaultImage: string;
  definition: string | null;
  disabled: boolean;
}) {
  const router = useRouter();
  const confirm = useConfirm();
  const start = React.useMemo(
    () => ({
      image: initial.image,
      args: initial.args,
      env: initial.env.map((e) => ({ name: e.name, value: "", stored: e.hasValue })),
      volumes: initial.volumes,
      ports: initial.ports,
    }),
    [initial],
  );
  const [value, setValue] = React.useState(start);
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);
  const [showDefinition, setShowDefinition] = React.useState(false);
  const dirty = JSON.stringify(value) !== JSON.stringify(start);

  const submit = async (input: unknown) => {
    setPending(true);
    setError(null);
    const res = await saveProxyContainer(serverId, kind, input);
    setPending(false);
    if (!res.ok) return setError(res.error);
    toast.success(input === null ? "Proxy container reset" : "Proxy container updated");
    router.refresh();
  };

  return (
    <Card>
      <CardHeader
        title="Proxy container"
        description="Change the image or add arguments, variables, volumes and ports. Saving recreates the container; if it does not come back healthy, the previous one is restored."
        actions={
          initial.customized && (
            <Button
              size="sm"
              variant="ghost"
              disabled={disabled}
              onClick={async () => {
                if (
                  await confirm({
                    title: "Reset the proxy container?",
                    description: `The container goes back to the default ${LABEL[kind]} definition and is recreated.`,
                    confirmLabel: "Reset",
                  })
                )
                  await submit(null);
              }}
            >
              <RotateCcw /> Reset to default
            </Button>
          )
        }
      />
      <CardBody className="flex flex-col divide-y divide-line p-0">
        <div className="px-5 py-4">
          <Field label="Image" description={`Default ${defaultImage}. Leave empty to follow the default.`}>
            <Input
              value={value.image}
              onChange={(e) => setValue({ ...value, image: e.target.value.trim() })}
              placeholder={defaultImage}
              className="font-mono"
              disabled={disabled}
            />
          </Field>
        </div>
        <ListEditor
          title="Arguments"
          description={kind === "nginx" ? "Added after nginx -g 'daemon off;'." : kind === "caddy" ? "Added after caddy run." : "Static Traefik options."}
          placeholder={kind === "traefik" ? "--entrypoints.web.transport.respondingTimeouts.readTimeout=60s" : "--flag"}
          items={value.args}
          onChange={(args) => setValue({ ...value, args })}
          disabled={disabled}
        />
        <ListEditor
          title="Published ports"
          description="Extra host ports, besides HTTP and HTTPS."
          placeholder="8404:8404 or 443:443/udp"
          items={value.ports}
          onChange={(ports) => setValue({ ...value, ports })}
          disabled={disabled}
        />
        <ListEditor
          title="Volumes"
          description="Host paths or volumes mounted into the proxy."
          placeholder="/srv/geoip:/geoip:ro"
          items={value.volumes}
          onChange={(volumes) => setValue({ ...value, volumes })}
          disabled={disabled}
        />
        <div className="flex flex-col gap-2 px-5 py-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-[13px] font-medium text-fg">Environment variables</p>
              <p className="text-xs text-muted">Stored encrypted. Leave a value empty to keep the saved one.</p>
            </div>
            <Button size="xs" onClick={() => setValue({ ...value, env: [...value.env, { name: "", value: "", stored: false }] })} disabled={disabled}>
              <Plus /> Add
            </Button>
          </div>
          {value.env.length === 0 && <p className="text-xs text-faint">None</p>}
          {value.env.map((e, i) => (
            <div key={i} className="flex items-center gap-2">
              <Input
                value={e.name}
                onChange={(ev) => setValue({ ...value, env: value.env.map((x, j) => (j === i ? { ...x, name: ev.target.value.trim() } : x)) })}
                placeholder="NAME"
                className="font-mono"
                aria-label="Variable name"
                disabled={disabled}
              />
              <Input
                type="password"
                value={e.value}
                onChange={(ev) => setValue({ ...value, env: value.env.map((x, j) => (j === i ? { ...x, value: ev.target.value } : x)) })}
                placeholder={e.stored ? "••••••••" : "value"}
                className="font-mono"
                aria-label="Variable value"
                autoComplete="new-password"
                disabled={disabled}
              />
              <Button
                size="xs"
                variant="danger-ghost"
                aria-label="Remove variable"
                onClick={() => setValue({ ...value, env: value.env.filter((_, j) => j !== i) })}
                disabled={disabled}
              >
                <Trash2 />
              </Button>
            </div>
          ))}
        </div>
        {definition && (
          <div className="flex flex-col gap-2 px-5 py-4">
            <button
              type="button"
              onClick={() => setShowDefinition(!showDefinition)}
              className="flex items-center gap-1.5 text-left text-[13px] font-medium text-fg-2 hover:text-fg"
              aria-expanded={showDefinition}
            >
              <ChevronRight className={cn("size-4 transition-transform", showDefinition && "rotate-90")} /> Effective definition
            </button>
            {showDefinition && <CodeView code={definition} maxHeight="360px" />}
          </div>
        )}
        {error && (
          <div className="px-5 py-4">
            <ErrorBox message={error} />
          </div>
        )}
      </CardBody>
      <CardFooter>
        <span className="truncate text-xs text-muted">{dirty ? "Unsaved changes" : initial.customized ? "Customized" : "Default container"}</span>
        <div className="flex flex-none gap-2">
          {dirty && (
            <Button variant="ghost" size="sm" onClick={() => (setValue(start), setError(null))}>
              Discard
            </Button>
          )}
          <Button
            variant="primary"
            size="sm"
            disabled={!dirty || disabled}
            loading={pending}
            onClick={() =>
              submit({
                image: value.image || null,
                args: clean(value.args),
                env: value.env.filter((e) => e.name).map((e) => ({ name: e.name, value: e.value })),
                volumes: clean(value.volumes),
                ports: clean(value.ports),
              })
            }
          >
            Recreate container
          </Button>
        </div>
      </CardFooter>
    </Card>
  );
}
