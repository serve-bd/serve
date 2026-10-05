"use client";

import * as React from "react";
import { ImageUp, Monitor, Moon, Plus, Smartphone, Sun, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, Label } from "@/components/ui/field";
import { Input, Textarea } from "@/components/ui/input";
import { Card, CardHeader } from "@/components/ui/misc";
import { Select } from "@/components/ui/select";
import { SwitchRow } from "@/components/ui/switch";
import { useAction } from "@/hooks/use-action";
import { removeStatusLogo, saveStatusPage, uploadStatusLogo } from "@/server/actions/status-pages";
import type { EditorData } from "@/server/status-pages/admin";
import { StatusView } from "@/components/status-page/status-view";
import { acceptedTypes, normalizeHex } from "@/lib/branding";
import { BAR_DAYS, DEFAULT_LABELS, type LabelKey, type StatusDesign } from "@/lib/status-page";
import { cn } from "@/lib/utils";
import type { PoweredBy } from "./editor";

type Form = Omit<StatusDesign, "logo" | "logoDark">;

const toForm = ({ logo: _l, logoDark: _d, ...rest }: StatusDesign): Form => rest;

/** Ready-made looks: a starting point, every value stays editable. */
const PRESETS: { name: string; design: Partial<Form> }[] = [
  { name: "Clean", design: { theme: "auto", font: "sans", corners: "round", density: "comfortable", accent: null } },
  { name: "Night", design: { theme: "dark", font: "sans", corners: "round", density: "comfortable", accent: "#7c9cff" } },
  { name: "Editorial", design: { theme: "light", font: "serif", corners: "square", density: "comfortable", accent: "#b4441f" } },
  { name: "Terminal", design: { theme: "dark", font: "mono", corners: "square", density: "compact", accent: "#3ddc84" } },
];

export function DesignTab({ data, canManage, poweredBy }: { data: EditorData; canManage: boolean; poweredBy: PoweredBy }) {
  const saved = React.useMemo(() => toForm(data.design), [data.design]);
  const [form, setForm] = React.useState<Form>(saved);
  const [device, setDevice] = React.useState<"desktop" | "phone">("desktop");
  React.useEffect(() => setForm(saved), [saved]);
  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm((f) => ({ ...f, [key]: value }));
  const dirty = JSON.stringify(form) !== JSON.stringify(saved);
  const save = useAction(() => saveStatusPage(data.page.id, { name: data.page.name, slug: data.page.slug, design: form }));
  const accentValid = !form.accent || !!normalizeHex(form.accent);

  // The preview draws the form as it is now, before saving.
  const preview: StatusDesign = { ...data.design, ...form, accent: form.accent && accentValid ? normalizeHex(form.accent) : null };
  const view = { ...data.view, logoUrl: data.logos.logo, logoDarkUrl: data.logos.logoDark };

  return (
    <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,420px)_minmax(0,1fr)]">
      <div className="flex flex-col gap-5">
        <Card>
          <CardHeader title="Starting point" description="Pick a look, then change anything below." />
          <div className="grid grid-cols-2 gap-2 px-5 py-4 sm:grid-cols-4 xl:grid-cols-2">
            {PRESETS.map((p) => (
              <button
                key={p.name}
                type="button"
                disabled={!canManage}
                onClick={() => setForm((f) => ({ ...f, ...p.design }))}
                className="rounded-lg border border-line px-3 py-2 text-left text-[13px] font-medium text-fg transition-colors hover:border-line-strong hover:bg-hover disabled:opacity-60"
              >
                {p.name}
              </button>
            ))}
          </div>
        </Card>

        <Card>
          <CardHeader title="Brand" />
          <div className="flex flex-col gap-4 px-5 py-4">
            <div className="grid grid-cols-3 gap-3">
              <LogoSlot pageId={data.page.id} kind="logo" title="Logo" url={data.logos.logo} surface="light" disabled={!canManage} />
              <LogoSlot pageId={data.page.id} kind="logoDark" title="Logo on dark" url={data.logos.logoDark} surface="dark" disabled={!canManage} />
              <LogoSlot pageId={data.page.id} kind="favicon" title="Favicon" url={data.logos.favicon} surface="light" disabled={!canManage} />
            </div>
            <p className="-mt-2 text-xs leading-relaxed text-muted">The favicon is the tab icon. Without one the logo stands in, then your instance's branding.</p>
            <SwitchRow title="Show the name next to the logo" checked={form.showName} onCheckedChange={(v) => set("showName", v)} disabled={!canManage} />
            <Field label="Description" optional>
              <Textarea
                value={form.description ?? ""}
                onChange={(e) => set("description", e.target.value || null)}
                rows={2}
                maxLength={500}
                placeholder="Live status of Acme's website, API and apps."
                disabled={!canManage}
              />
            </Field>
            <Field label="Logo links to" optional>
              <Input value={form.website ?? ""} onChange={(e) => set("website", e.target.value || null)} placeholder="https://acme.com" disabled={!canManage} />
            </Field>
            <Field
              label="Accent color"
              optional
              description="Links and highlights. Status colors stay green, amber and red."
              error={accentValid ? null : "Use a hex color, like #0a84ff."}
            >
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  value={normalizeHex(form.accent ?? "") ?? "#14161a"}
                  onChange={(e) => set("accent", e.target.value)}
                  className="size-9 flex-none cursor-pointer rounded-lg border border-line-strong bg-surface p-1"
                  aria-label="Pick the accent color"
                  disabled={!canManage}
                />
                <Input value={form.accent ?? ""} onChange={(e) => set("accent", e.target.value || null)} placeholder="Default" className="font-mono" disabled={!canManage} />
                {form.accent && (
                  <Button variant="ghost" size="icon-sm" aria-label="Default color" onClick={() => set("accent", null)} disabled={!canManage}>
                    <X />
                  </Button>
                )}
              </div>
            </Field>
          </div>
        </Card>

        <Card>
          <CardHeader title="Look" />
          <div className="grid grid-cols-2 gap-4 px-5 py-4">
            <Field label="Theme">
              <Select
                value={form.theme}
                onValueChange={(v) => set("theme", v as Form["theme"])}
                disabled={!canManage}
                options={[
                  { value: "auto", label: "Visitor's choice" },
                  { value: "light", label: "Light" },
                  { value: "dark", label: "Dark" },
                ]}
              />
            </Field>
            <Field label="Font">
              <Select
                value={form.font}
                onValueChange={(v) => set("font", v as Form["font"])}
                disabled={!canManage}
                options={[
                  { value: "sans", label: "Sans" },
                  { value: "serif", label: "Serif" },
                  { value: "mono", label: "Mono" },
                ]}
              />
            </Field>
            <Field label="Corners">
              <Select
                value={form.corners}
                onValueChange={(v) => set("corners", v as Form["corners"])}
                disabled={!canManage}
                options={[
                  { value: "round", label: "Round" },
                  { value: "square", label: "Square" },
                ]}
              />
            </Field>
            <Field label="Spacing">
              <Select
                value={form.density}
                onValueChange={(v) => set("density", v as Form["density"])}
                disabled={!canManage}
                options={[
                  { value: "comfortable", label: "Roomy" },
                  { value: "compact", label: "Compact" },
                ]}
              />
            </Field>
          </div>
        </Card>

        <Card>
          <CardHeader title="Components" />
          <div className="flex flex-col gap-3 px-5 py-4">
            <SwitchRow
              title="Daily bars"
              description="One bar per day, colored by uptime and incidents."
              checked={form.showBars}
              onCheckedChange={(v) => set("showBars", v)}
              disabled={!canManage}
            />
            {form.showBars && (
              <Field label="Days of bars">
                <Select
                  value={String(form.days)}
                  onValueChange={(v) => set("days", Number(v) as Form["days"])}
                  disabled={!canManage}
                  options={BAR_DAYS.map((d) => ({ value: String(d), label: `${d} days` }))}
                />
              </Field>
            )}
            <SwitchRow title="Uptime percent" checked={form.showUptime} onCheckedChange={(v) => set("showUptime", v)} disabled={!canManage} />
            <SwitchRow
              title="Response time"
              description="A chart of the last day, from the uptime checks."
              checked={form.showLatency}
              onCheckedChange={(v) => set("showLatency", v)}
              disabled={!canManage}
            />
          </div>
        </Card>

        <Card>
          <CardHeader title="History" />
          <div className="flex flex-col gap-3 px-5 py-4">
            <Field label="Past incidents" description="How far back the list under the components goes.">
              <Select
                value={String(form.historyDays)}
                onValueChange={(v) => set("historyDays", Number(v))}
                disabled={!canManage}
                options={[0, 7, 14, 30, 60, 90].map((d) => ({ value: String(d), label: d ? `${d} days` : "Hidden" }))}
              />
            </Field>
            <SwitchRow
              title="Show outages found by checks"
              description="When an uptime check finds a component down, the page says so without you posting anything."
              checked={form.autoIncidents}
              onCheckedChange={(v) => set("autoIncidents", v)}
              disabled={!canManage}
            />
          </div>
        </Card>

        <Card>
          <CardHeader title="Banner and links" />
          <div className="flex flex-col gap-4 px-5 py-4">
            <Field label="Banner" optional description="A note over everything, like a coming price change or a known issue elsewhere.">
              <Textarea
                value={form.announcement?.text ?? ""}
                onChange={(e) => set("announcement", e.target.value ? { text: e.target.value, tone: form.announcement?.tone ?? "info" } : null)}
                rows={2}
                maxLength={500}
                disabled={!canManage}
              />
            </Field>
            {form.announcement && (
              <Field label="Banner color">
                <Select
                  value={form.announcement.tone}
                  onValueChange={(v) => set("announcement", { text: form.announcement!.text, tone: v as "info" | "warn" })}
                  disabled={!canManage}
                  options={[
                    { value: "info", label: "Plain" },
                    { value: "warn", label: "Amber" },
                  ]}
                />
              </Field>
            )}
            <div className="flex flex-col gap-2">
              <Label>Header links</Label>
              {form.links.map((l, i) => (
                <div key={i} className="flex items-center gap-2">
                  <Input
                    value={l.label}
                    onChange={(e) =>
                      set(
                        "links",
                        form.links.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)),
                      )
                    }
                    placeholder="Support"
                    className="w-[38%]"
                    aria-label="Link label"
                    disabled={!canManage}
                  />
                  <Input
                    value={l.url}
                    onChange={(e) =>
                      set(
                        "links",
                        form.links.map((x, j) => (j === i ? { ...x, url: e.target.value } : x)),
                      )
                    }
                    placeholder="https://acme.com/help"
                    aria-label="Link address"
                    disabled={!canManage}
                  />
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Remove link"
                    onClick={() =>
                      set(
                        "links",
                        form.links.filter((_, j) => j !== i),
                      )
                    }
                    disabled={!canManage}
                  >
                    <Trash2 />
                  </Button>
                </div>
              ))}
              <Button size="sm" variant="ghost" className="self-start" onClick={() => set("links", [...form.links, { label: "", url: "" }])} disabled={!canManage}>
                <Plus /> Add link
              </Button>
            </div>
            <Field label="Footer text" optional>
              <Input value={form.footer ?? ""} onChange={(e) => set("footer", e.target.value || null)} placeholder="© Acme Inc." maxLength={500} disabled={!canManage} />
            </Field>
            <SwitchRow title={`Hide “Powered by ${poweredBy.name}”`} checked={form.hideBadge} onCheckedChange={(v) => set("hideBadge", v)} disabled={!canManage} />
          </div>
        </Card>

        <WordsCard form={form} set={set} disabled={!canManage} />

        <Card>
          <CardHeader title="Advanced" />
          <div className="flex flex-col gap-4 px-5 py-4">
            <Field
              label="Custom CSS"
              optional
              description={
                <>
                  Applies to this page only. Hooks: <code className="font-mono">.sp</code>, <code className="font-mono">.sp-header</code>,{" "}
                  <code className="font-mono">.sp-overall</code>, <code className="font-mono">.sp-component</code>, <code className="font-mono">.sp-notice</code>,{" "}
                  <code className="font-mono">.sp-footer</code>. Colors are variables like <code className="font-mono">--sp-bg</code> and <code className="font-mono">--sp-ok</code>
                  .
                </>
              }
            >
              <Textarea
                value={form.css ?? ""}
                onChange={(e) => set("css", e.target.value || null)}
                rows={6}
                spellCheck={false}
                className="font-mono text-xs"
                placeholder={".sp { --sp-bg: #fbfaf7; }\n.sp-overall { border-width: 2px; }"}
                disabled={!canManage}
              />
            </Field>
            <SwitchRow title="Hide from search engines" checked={form.noindex} onCheckedChange={(v) => set("noindex", v)} disabled={!canManage} />
          </div>
        </Card>

        {canManage && (
          <div className="sticky bottom-4 z-10 flex items-center justify-end gap-3 rounded-xl border border-line bg-glass px-4 py-3 shadow-md backdrop-blur-xl">
            <span className="mr-auto text-[13px] text-muted">{dirty ? "Unsaved changes" : "Saved"}</span>
            <Button size="sm" variant="ghost" disabled={!dirty || save.pending} onClick={() => setForm(saved)}>
              Discard
            </Button>
            <Button size="sm" variant="primary" disabled={!dirty || !accentValid} loading={save.pending} onClick={() => save.run()}>
              Save
            </Button>
          </div>
        )}
      </div>

      <div className="flex flex-col gap-3 xl:sticky xl:top-4">
        <div className="flex items-center justify-between gap-3">
          <p className="text-[13px] font-medium text-fg-2">Preview</p>
          <div className="flex items-center gap-1 rounded-lg border border-line bg-sunken p-0.5">
            {(
              [
                ["desktop", Monitor, "Desktop"],
                ["phone", Smartphone, "Phone"],
              ] as const
            ).map(([key, Icon, label]) => (
              <button
                key={key}
                type="button"
                aria-label={label}
                aria-pressed={device === key}
                onClick={() => setDevice(key)}
                className={cn("rounded-md p-1.5 text-muted transition-colors hover:text-fg", device === key && "bg-surface text-fg shadow-sm")}
              >
                <Icon className="size-3.5" />
              </button>
            ))}
            <span className="mx-1 h-4 w-px bg-line" />
            <ThemeHint theme={form.theme} />
          </div>
        </div>
        {/* The frame itself takes the device's width, so its scrollbar sits at its edge. */}
        <div
          className={cn(
            "mx-auto w-full overflow-hidden border border-line-strong shadow-md transition-[max-width] duration-300",
            device === "phone" ? "max-w-[390px] rounded-[28px]" : "max-w-full rounded-xl",
          )}
        >
          <div className="max-h-[calc(100dvh-9rem)] overflow-y-auto">
            <StatusView view={view} design={preview} base={`/status/${data.page.slug}`} poweredBy={poweredBy} />
          </div>
        </div>
      </div>
    </div>
  );
}

function ThemeHint({ theme }: { theme: StatusDesign["theme"] }) {
  const Icon = theme === "dark" ? Moon : theme === "light" ? Sun : Monitor;
  return (
    <span className="flex items-center gap-1 px-1.5 text-[11px] text-muted" title={theme === "auto" ? "Follows the visitor's device; the preview follows yours" : undefined}>
      <Icon className="size-3.5" /> {theme === "auto" ? "Auto" : theme === "dark" ? "Dark" : "Light"}
    </span>
  );
}

function LogoSlot({
  pageId,
  kind,
  title,
  url,
  surface,
  disabled,
}: {
  pageId: string;
  kind: "logo" | "logoDark" | "favicon";
  title: string;
  url: string | null;
  surface: "light" | "dark";
  disabled: boolean;
}) {
  const input = React.useRef<HTMLInputElement>(null);
  const upload = useAction((file: File) => {
    const form = new FormData();
    form.set("file", file);
    return uploadStatusLogo(pageId, kind, form);
  });
  const remove = useAction(() => removeStatusLogo(pageId, kind));
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <span className="text-[13px] font-medium text-fg-2">{title}</span>
      <button
        type="button"
        disabled={disabled || upload.pending}
        onClick={() => input.current?.click()}
        className={cn(
          "flex h-16 items-center justify-center rounded-lg border border-dashed border-line-strong px-3 transition-colors hover:border-accent",
          surface === "light" ? "bg-[#f6f7f9]" : "bg-[#0c0d10]",
        )}
        aria-label={url ? `Replace the ${title.toLowerCase()}` : `Upload a ${title.toLowerCase()}`}
      >
        {url ? (
          // Uploaded images are only drawn through <img>, so an SVG cannot run scripts.
          <img src={url} alt="" className="h-8 max-w-full object-contain" draggable={false} />
        ) : (
          <span className={cn("flex items-center gap-1.5 text-xs", surface === "dark" ? "text-white/45" : "text-black/40")}>
            <ImageUp className="size-3.5" /> Upload
          </span>
        )}
      </button>
      <input
        ref={input}
        type="file"
        accept={kind === "favicon" ? `${acceptedTypes.favicon.join(",")},.ico` : acceptedTypes.logo.join(",")}
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) void upload.run(file);
        }}
      />
      {url && !disabled && (
        <Button size="xs" variant="ghost" className="self-start" loading={remove.pending} onClick={() => remove.run()}>
          <Trash2 /> Remove
        </Button>
      )}
    </div>
  );
}

/** Groups of the page's texts, in the order visitors meet them. */
const WORD_GROUPS: { title: string; keys: LabelKey[] }[] = [
  { title: "Banner", keys: ["overall.operational", "overall.degraded", "overall.partial", "overall.major", "overall.maintenance", "overall.unknown", "updated"] },
  {
    title: "Components",
    keys: ["level.operational", "level.degraded", "level.partial", "level.major", "level.maintenance", "level.unknown", "uptime", "responseTime", "daysAgo", "today", "noData"],
  },
  {
    title: "Incidents",
    keys: [
      "state.investigating",
      "state.identified",
      "state.monitoring",
      "state.resolved",
      "state.scheduled",
      "state.in-progress",
      "state.completed",
      "planned",
      "past",
      "noIncidents",
      "started",
      "lasted",
      "postmortem",
      "outageOne",
      "outageOnePast",
    ],
  },
  { title: "Footer", keys: ["subscribe", "poweredBy"] },
];

function WordsCard({ form, set, disabled }: { form: Form; set: <K extends keyof Form>(key: K, value: Form[K]) => void; disabled: boolean }) {
  const [open, setOpen] = React.useState<string | null>(null);
  const changed = Object.values(form.labels).filter((v) => v?.trim()).length;
  const setWord = (key: LabelKey, value: string) => {
    const next = { ...form.labels };
    if (value) next[key] = value;
    else delete next[key];
    set("labels", next);
  };
  return (
    <Card>
      <CardHeader title="Words and language" description={changed ? `${changed} text${changed === 1 ? "" : "s"} changed.` : "Reword or translate any text on the page."} />
      <div className="flex flex-col gap-4 px-5 py-4">
        <Field label="Language of dates" optional description="A code like en, de, fr or pt-BR. Empty uses each visitor's own.">
          <Input
            value={form.locale ?? ""}
            onChange={(e) => set("locale", e.target.value || null)}
            placeholder="Visitor's language"
            className="font-mono"
            maxLength={35}
            disabled={disabled}
          />
        </Field>
        <div className="flex flex-col divide-y divide-line rounded-lg border border-line">
          {WORD_GROUPS.map((g) => (
            <div key={g.title}>
              <button
                type="button"
                className="flex w-full items-center justify-between px-3 py-2.5 text-left text-[13px] font-medium text-fg hover:bg-hover/50"
                aria-expanded={open === g.title}
                onClick={() => setOpen(open === g.title ? null : g.title)}
              >
                {g.title}
                <span className="text-xs text-muted">{g.keys.filter((k) => form.labels[k]).length || ""}</span>
              </button>
              {open === g.title && (
                <div className="flex flex-col gap-2 px-3 pb-3">
                  {g.keys.map((k) => (
                    <Input
                      key={k}
                      value={form.labels[k] ?? ""}
                      onChange={(e) => setWord(k, e.target.value)}
                      placeholder={DEFAULT_LABELS[k]}
                      aria-label={DEFAULT_LABELS[k]}
                      maxLength={200}
                      disabled={disabled}
                    />
                  ))}
                  {g.keys.some((k) => DEFAULT_LABELS[k].includes("{")) && (
                    <p className="text-xs text-muted">
                      <code className="font-mono">{"{days}"}</code> and <code className="font-mono">{"{name}"}</code> are filled in.
                    </p>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </Card>
  );
}
