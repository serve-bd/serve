"use client";

import * as React from "react";
import { useRouter } from "@/hooks/use-router";
import YAML from "yaml";
import { Download, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Card, CardBody, CardHeader } from "@/components/ui/misc";
import { CodeEditor } from "@/components/code-editor";
import { TemplateLogo } from "@/components/template-logo";
import { useAction } from "@/hooks/use-action";
import { fetchComposeFromUrl, saveCustomTemplate } from "@/server/actions/templates";
import { composeVariables, guessVarKind } from "@/lib/compose-vars";
import { cn } from "@/lib/utils";

type VarKind = "value" | "password" | "strongPassword" | "secret" | "hex32" | "hex16" | "base64key" | "publicUrl" | "publicHost";
type VarRow = { key: string; kind: VarKind; value: string; label: string };
type Generate = "password" | "strongPassword" | "secret" | "hex32" | "hex16" | "base64key";
export type TemplateVarDef = { key: string; generate?: Generate; value?: string; publicUrl?: boolean; publicHost?: boolean; label?: string };

export type EditorInitial = {
  id: string | null;
  name: string;
  description: string;
  category: string;
  iconUrl: string;
  compose: string;
  vars: TemplateVarDef[];
  exposeService: string | null;
  exposePort: number | null;
};

const kindOptions: { value: VarKind; label: string; description: string }[] = [
  { value: "value", label: "Value", description: "A default the user can change" },
  { value: "password", label: "Password", description: "24 random characters" },
  { value: "strongPassword", label: "Strong password", description: "With upper and lower case, a digit and a symbol" },
  { value: "secret", label: "Secret", description: "Random 32-byte token" },
  { value: "hex32", label: "Hex key", description: "64 hex-safe characters" },
  { value: "hex16", label: "32-character key", description: "32 hex characters (16 bytes)" },
  { value: "base64key", label: "App key (base64:)", description: "Laravel-style APP_KEY" },
  { value: "publicUrl", label: "Public URL", description: "https://domain, follows the domain" },
  { value: "publicHost", label: "Public hostname", description: "domain only, follows the domain" },
];

function toRow(v: TemplateVarDef): VarRow {
  const kind: VarKind = v.publicUrl ? "publicUrl" : v.publicHost ? "publicHost" : ((v.generate as VarKind | undefined) ?? "value");
  return { key: v.key, kind, value: v.value ?? "", label: v.label ?? "" };
}

function fromRow(r: VarRow): TemplateVarDef {
  const base = { key: r.key, ...(r.label.trim() ? { label: r.label.trim() } : {}) };
  if (r.kind === "publicUrl") return { ...base, publicUrl: true };
  if (r.kind === "publicHost") return { ...base, publicHost: true };
  if (r.kind === "value") return { ...base, value: r.value };
  return { ...base, generate: r.kind as Generate };
}

function analyze(compose: string) {
  try {
    const doc = YAML.parse(compose) as { services?: Record<string, { ports?: unknown[]; expose?: unknown[] }> } | null;
    if (!doc?.services || typeof doc.services !== "object") return { error: "The file has no services.", services: [] as { name: string; ports: number[] }[] };
    const services = Object.entries(doc.services).map(([name, svc]) => {
      const ports = new Set<number>();
      for (const p of [...(svc?.expose ?? []), ...(svc?.ports ?? [])]) {
        const str = typeof p === "object" && p ? String((p as { target?: number }).target ?? "") : String(p);
        const container = str.split(":").pop()?.split("/")[0];
        if (container && /^\d+$/.test(container)) ports.add(Number(container));
      }
      return { name, ports: [...ports] };
    });
    return { error: null, services };
  } catch (e) {
    let error = (e as Error).message.split("\n")[0].replace(/:\s*$/, ".");
    // The parser only notices an unclosed quote at the end of the file; point at where it opens.
    if (/closing "?quote|Missing closing/i.test(error)) {
      const line = unclosedQuoteLine(compose);
      if (line) error = `A quote on line ${line} is never closed.`;
    }
    return { error, services: [] as { name: string; ports: number[] }[] };
  }
}

/** First line with an odd number of double (or single) quotes, ignoring comments. */
function unclosedQuoteLine(text: string): number | null {
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const code = lines[i].replace(/\\./g, "").replace(/(^|\s)#.*$/, "");
    const doubles = (code.match(/"/g) ?? []).length;
    const singles = (code.replace(/"[^"]*"/g, "").match(/'/g) ?? []).length;
    if (doubles % 2 === 1 || singles % 2 === 1) return i + 1;
  }
  return null;
}

export function TemplateEditor({ initial, categories }: { initial: EditorInitial; categories: string[] }) {
  const router = useRouter();
  const [name, setName] = React.useState(initial.name);
  const [description, setDescription] = React.useState(initial.description);
  const [category, setCategory] = React.useState(initial.category);
  const [iconUrl, setIconUrl] = React.useState(initial.iconUrl);
  const [compose, setCompose] = React.useState(initial.compose);
  const [rows, setRows] = React.useState<VarRow[]>(() => initial.vars.map(toRow));
  const [exposeService, setExposeService] = React.useState(initial.exposeService ?? "");
  const [exposePort, setExposePort] = React.useState(initial.exposePort ? String(initial.exposePort) : "");
  const [importUrl, setImportUrl] = React.useState("");

  const parsed = React.useMemo(() => analyze(compose), [compose]);
  const detected = React.useMemo(() => composeVariables(compose), [compose]);
  const missing = detected.filter((d) => !d.hasDefault && !rows.some((r) => r.key === d.name));
  const unused = rows.filter((r) => !detected.some((d) => d.name === r.key));
  const exposed = parsed.services.find((s) => s.name === exposeService);

  const syncVars = React.useCallback((content: string) => {
    const found = composeVariables(content);
    setRows((current) => [
      ...current.filter((r) => found.some((f) => f.name === r.key)),
      ...found.filter((f) => !current.some((r) => r.key === f.name)).map((f) => ({ key: f.name, kind: guessVarKind(f.name) as VarKind, value: "", label: "" })),
    ]);
  }, []);

  /** Detect variables and, when none is chosen yet, the service that gets the domain. */
  const refresh = (content: string) => {
    syncVars(content);
    const services = analyze(content).services;
    const first = services.find((s) => s.ports.length) ?? services[0];
    if (first && !exposeService) {
      setExposeService(first.name);
      if (first.ports[0]) setExposePort(String(first.ports[0]));
    }
  };
  /** While typing: pick the domain service as soon as the file names one (nothing else changes). */
  const onComposeChange = (content: string) => {
    setCompose(content);
    if (exposeService) return;
    const services = analyze(content).services;
    const first = services.find((s) => s.ports.length);
    if (first) {
      setExposeService(first.name);
      setExposePort(String(first.ports[0]));
    }
  };
  const loadCompose = (content: string) => {
    setCompose(content);
    refresh(content);
  };

  const fetchUrl = useAction(fetchComposeFromUrl, { refresh: false, onSuccess: (text) => loadCompose(text) });
  const save = useAction((input: Parameters<typeof saveCustomTemplate>[1]) => saveCustomTemplate(initial.id, input), {
    result: initial.id ? "" : "Template created. It is now in the New service catalog.",
    onSuccess: () => router.push("/templates"),
  });

  const categoryOptions = [...new Set(["Custom", ...categories, category])].map((c) => ({ value: c, label: c }));

  return (
    <form
      className="flex flex-col gap-5"
      onSubmit={(e) => {
        e.preventDefault();
        void save.run({
          name,
          description,
          category,
          iconUrl: iconUrl.trim() || null,
          compose,
          vars: rows.map(fromRow),
          exposeService: exposeService || null,
          exposePort: exposeService && exposePort ? Number(exposePort) : null,
        });
      }}
    >
      <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="flex min-w-0 flex-col gap-5">
          <Card>
            <CardHeader title="Compose file" description={<>Use {"${VARIABLE}"} for values that differ per service. They are filled in when a service is created.</>} />
            <CardBody className="flex flex-col gap-4 py-5">
              <div className="flex flex-col gap-2 sm:flex-row">
                <Input
                  value={importUrl}
                  onChange={(e) => setImportUrl(e.target.value)}
                  placeholder="Import from a URL, e.g. a GitHub link to docker-compose.yml"
                  className="font-mono text-[12.5px]"
                  aria-label="Compose file URL"
                />
                <Button type="button" size="md" loading={fetchUrl.pending} disabled={!importUrl.trim()} onClick={() => fetchUrl.run(importUrl)} className="flex-none">
                  <Download /> Import
                </Button>
              </div>
              <CodeEditor
                value={compose}
                onChange={onComposeChange}
                onBlur={() => refresh(compose)}
                minRows={22}
                maxHeight="44rem"
                aria-label="docker-compose.yml"
                placeholder={"services:\n  app:\n    image: ghcr.io/owner/app:latest\n    environment:\n      SECRET_KEY: ${SECRET_KEY}\n"}
              />
              {parsed.error ? (
                <p className={cn("text-xs", compose.trim() ? "text-bad" : "text-muted")}>{compose.trim() ? parsed.error : "Paste a compose file or import one."}</p>
              ) : (
                <p className="text-xs text-muted">
                  {parsed.services.length} service{parsed.services.length === 1 ? "" : "s"}: {parsed.services.map((s) => s.name).join(", ")}
                </p>
              )}
            </CardBody>
          </Card>
          <Card>
            <CardHeader
              title="Variables"
              description="How each ${VARIABLE} is filled when someone creates a service."
              actions={
                <Button type="button" size="sm" variant="ghost" onClick={() => refresh(compose)}>
                  <RefreshCw /> Detect
                </Button>
              }
            />
            {rows.length ? (
              <div className="divide-y divide-line">
                {rows.map((r, i) => {
                  const set = (patch: Partial<VarRow>) => setRows((all) => all.map((x, j) => (j === i ? { ...x, ...patch } : x)));
                  return (
                    <div key={r.key} className="grid grid-cols-1 gap-2 px-5 py-3 sm:grid-cols-[minmax(0,1fr)_11rem_minmax(0,1fr)] sm:items-center">
                      <span
                        className={cn("truncate font-mono text-[12.5px]", unused.includes(r) ? "text-faint line-through" : "text-fg")}
                        title={unused.includes(r) ? "Not used in the compose file" : undefined}
                      >
                        {r.key}
                      </span>
                      <Select size="sm" value={r.kind} onValueChange={(v) => set({ kind: v as VarKind })} options={kindOptions} />
                      {r.kind === "value" ? (
                        <Input
                          value={r.value}
                          onChange={(e) => set({ value: e.target.value })}
                          placeholder="Default value"
                          className="h-8 font-mono text-[12.5px]"
                          aria-label={`${r.key} default`}
                        />
                      ) : (
                        <Input
                          value={r.label}
                          onChange={(e) => set({ label: e.target.value })}
                          placeholder="Label (optional)"
                          className="h-8 text-[12.5px]"
                          aria-label={`${r.key} label`}
                        />
                      )}
                    </div>
                  );
                })}
              </div>
            ) : (
              <CardBody className="py-5 text-[13px] text-muted">No ${"{VARIABLES}"} in the compose file.</CardBody>
            )}
            {missing.length > 0 && (
              <CardBody className="border-t border-line py-3 text-xs text-warn">Not listed yet: {missing.map((m) => m.name).join(", ")}. Click Detect.</CardBody>
            )}
          </Card>
        </div>
        <aside className="flex min-w-0 flex-col gap-5 lg:sticky lg:top-6">
          <Card>
            <CardHeader title="Details" description="How the template appears in the New service catalog." />
            <CardBody className="flex flex-col gap-4 py-5">
              <Field label="Name">
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Internal wiki" required maxLength={60} />
              </Field>
              <Field label="Category">
                <Select value={category} onValueChange={setCategory} options={categoryOptions} />
              </Field>
              <Field label="Description" optional>
                <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What it is, in one line" maxLength={200} />
              </Field>
              <Field label="Icon" optional description="URL of a square PNG or SVG. Leave empty for a lettered tile.">
                <div className="flex items-center gap-3">
                  <TemplateLogo id={initial.id ?? "new"} name={name || "?"} iconUrl={iconUrl.trim() || null} custom className="size-9 flex-none rounded-[10px]" />
                  <Input value={iconUrl} onChange={(e) => setIconUrl(e.target.value)} placeholder="https://example.com/logo.svg" className="font-mono text-[13px]" />
                </div>
              </Field>
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Domain" description="The compose service and port that get the generated domain. Leave empty for stacks without a web UI." />
            <CardBody className="grid grid-cols-1 gap-4 py-5">
              <Field label="Service" description={parsed.services.length ? undefined : "Add a compose file first. Its services show up here."}>
                <Select
                  value={exposeService || "none"}
                  disabled={!parsed.services.length}
                  onValueChange={(v) => {
                    const svc = v === "none" ? "" : v;
                    setExposeService(svc);
                    const ports = parsed.services.find((s) => s.name === svc)?.ports ?? [];
                    if (ports[0]) setExposePort(String(ports[0]));
                  }}
                  options={[
                    { value: "none", label: "No domain" },
                    ...parsed.services.map((s) => ({ value: s.name, label: s.name, description: s.ports.length ? `Ports ${s.ports.join(", ")}` : undefined })),
                  ]}
                />
              </Field>
              <Field label="Port" description={exposed?.ports.length ? `Found in the file: ${exposed.ports.join(", ")}` : "The port the app listens on inside the container."}>
                <Input value={exposePort} onChange={(e) => setExposePort(e.target.value.replace(/\D/g, ""))} placeholder="3000" inputMode="numeric" disabled={!exposeService} />
              </Field>
            </CardBody>
          </Card>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => router.push("/templates")}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" size="sm" loading={save.pending} disabled={!name.trim() || !!parsed.error}>
              {initial.id ? "Save template" : "Create template"}
            </Button>
          </div>
        </aside>
      </div>
    </form>
  );
}
