"use client";

import * as React from "react";
import { ImageUp, RotateCcw, Trash2 } from "lucide-react";
import { Logo } from "@/components/brand";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Badge, Card, CardBody, CardFooter, CardHeader } from "@/components/ui/misc";
import { SwitchRow } from "@/components/ui/switch";
import { useConfirm } from "@/components/ui/confirm";
import { useAction } from "@/hooks/use-action";
import { useTheme } from "@/hooks/use-client";
import { acceptedTypes, accentTokens, type BrandAssetKind, DEFAULT_PRODUCT_NAME, normalizeHex } from "@/lib/branding";
import { cn } from "@/lib/utils";
import { removeBrandImage, resetBranding, saveBranding, uploadBrandImage } from "@/server/actions/branding";
import type { Brand } from "@/server/branding";

type Values = { name: string; showName: boolean; accent: string };

const presets = ["#0a84ff", "#5e5ce6", "#bf5af2", "#ff375f", "#ff9f0a", "#30d158", "#40c8e0", "#1d1d1f"];

export function BrandingSettings({ initial, brand, has }: { initial: Values; brand: Brand; has: Record<BrandAssetKind, boolean> }) {
  const confirm = useConfirm();
  const { theme } = useTheme();
  const [v, setV] = React.useState(initial);
  const [saved, setSaved] = React.useState(JSON.stringify(initial));
  const dirty = JSON.stringify(v) !== saved;
  const set =
    <K extends keyof Values>(k: K) =>
    (value: Values[K]) =>
      setV((s) => ({ ...s, [k]: value }));
  const hex = v.accent.trim() ? normalizeHex(v.accent) : null;
  const accentInvalid = !!v.accent.trim() && !hex;
  const tokens = hex ? accentTokens(hex)?.[theme] : null;

  const save = useAction(() => saveBranding({ name: v.name, showName: v.showName, accent: v.accent.trim() || null }), {
    onSuccess: () => setSaved(JSON.stringify(v)),
  });
  const reset = useAction(resetBranding, {
    onSuccess: () => {
      const next = { name: DEFAULT_PRODUCT_NAME, showName: true, accent: "" };
      setV(next);
      setSaved(JSON.stringify(next));
    },
  });

  // The preview uses the unsaved name and colour with the uploaded images.
  const preview: Brand = { ...brand, name: v.name.trim() || DEFAULT_PRODUCT_NAME, showName: brand.logoUrl ? v.showName : true };
  const previewStyle = tokens
    ? ({ "--accent": tokens.accent, "--accent-strong": tokens.strong, "--accent-fg": tokens.fg, "--accent-soft": tokens.soft, "--ring": tokens.ring } as React.CSSProperties)
    : undefined;

  return (
    <>
      <Card>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!accentInvalid) void save.run();
          }}
        >
          <CardHeader title="Branding" description="Your name, logo and colour replace the defaults across the dashboard, the sign-in page, the browser tab and emails." />
          <CardBody className="grid grid-cols-1 gap-6 py-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,18rem)]">
            <div className="flex min-w-0 flex-col gap-5">
              <Field label="Product name" optional description={`Shown next to the logo, in page titles and in emails. Empty shows ${DEFAULT_PRODUCT_NAME}.`}>
                <Input value={v.name} onChange={(e) => set("name")(e.target.value)} maxLength={40} placeholder={DEFAULT_PRODUCT_NAME} className="sm:max-w-sm" />
              </Field>
              <Field
                label="Accent colour"
                optional
                error={accentInvalid ? "Use a hex colour like #0a84ff." : undefined}
                description="Buttons, links and highlights. It is adjusted a little in each theme so it stays readable."
              >
                <div className="flex flex-wrap items-center gap-2">
                  <label className="relative flex size-9 flex-none cursor-pointer items-center justify-center overflow-hidden rounded-[10px] border border-line-strong shadow-sm">
                    <span className="absolute inset-0" style={{ background: hex ?? "var(--accent)" }} />
                    <input
                      type="color"
                      value={hex ?? "#0a84ff"}
                      onChange={(e) => set("accent")(e.target.value)}
                      className="absolute inset-0 cursor-pointer opacity-0"
                      aria-label="Pick an accent colour"
                    />
                  </label>
                  <Input
                    value={v.accent}
                    onChange={(e) => set("accent")(e.target.value)}
                    placeholder="Default"
                    className="w-32 font-mono text-[13px]"
                    aria-label="Accent colour hex"
                  />
                  <div className="flex flex-wrap items-center gap-1.5">
                    {presets.map((p) => (
                      <button
                        key={p}
                        type="button"
                        onClick={() => set("accent")(p)}
                        aria-label={`Use ${p}`}
                        className={cn(
                          "size-6 rounded-full ring-offset-2 ring-offset-surface transition-shadow",
                          hex === p ? "ring-2 ring-fg/60" : "hover:ring-2 hover:ring-line-strong",
                        )}
                        style={{ background: p }}
                      />
                    ))}
                  </div>
                  {v.accent && (
                    <Button type="button" size="xs" variant="ghost" onClick={() => set("accent")("")}>
                      Default
                    </Button>
                  )}
                </div>
              </Field>
              <SwitchRow
                title="Show the name next to the logo"
                description={brand.logoUrl ? "Turn off when the logo already contains the name." : "Available once you upload a logo."}
                checked={brand.logoUrl ? v.showName : true}
                disabled={!brand.logoUrl}
                onCheckedChange={(c) => set("showName")(c)}
              />
            </div>

            <div className="flex min-w-0 flex-col gap-2">
              <span className="text-[13px] font-medium text-fg-2">Preview</span>
              <div style={previewStyle} className="flex flex-col gap-4 rounded-xl border border-line bg-bg p-4">
                <Logo brand={preview} />
                <div className="flex flex-col gap-1">
                  <span className="flex h-8 items-center rounded-lg bg-accent-soft px-2.5 text-[13px] font-medium text-accent">Projects</span>
                  <span className="flex h-8 items-center rounded-lg px-2.5 text-[13px] text-fg-2">Servers</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="inline-flex h-8 items-center rounded-lg bg-accent px-3 text-[13px] font-medium text-accent-fg">Deploy</span>
                  <span className="text-[13px] text-accent">Open link</span>
                </div>
                <p className="truncate text-xs text-muted">Tab title: Projects · {preview.name}</p>
              </div>
            </div>
          </CardBody>
          <CardFooter>
            <span className="truncate text-xs text-muted">{dirty ? "Unsaved changes" : ""}</span>
            <div className="flex flex-none gap-2">
              {dirty && (
                <Button type="button" size="sm" variant="ghost" onClick={() => setV(JSON.parse(saved))}>
                  Discard
                </Button>
              )}
              <Button type="submit" size="sm" variant="primary" loading={save.pending} disabled={!dirty || accentInvalid}>
                Save
              </Button>
            </div>
          </CardFooter>
        </form>
      </Card>

      <Card>
        <CardHeader title="Logo" description="PNG, JPEG, WebP or SVG, up to 512 KB. Shown about 28 pixels high; wide logos are fine." />
        <CardBody className="grid grid-cols-1 gap-4 py-5 sm:grid-cols-2">
          <ImageSlot kind="logo" title="Logo" hint="Used in both themes unless you add a dark mode logo." url={brand.logoUrl} present={has.logo} surface="light" />
          <ImageSlot
            kind="logoDark"
            title="Dark mode logo"
            hint="Optional. Used in the dark theme and on the dark sign-in panel."
            url={brand.logoDarkUrl}
            present={has.logoDark}
            surface="dark"
          />
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Favicon" description="The icon in the browser tab. PNG, SVG or ICO, up to 512 KB; square images work best." />
        <CardBody className="py-5">
          <ImageSlot
            kind="favicon"
            title="Favicon"
            hint={has.favicon ? "Shown in browser tabs and bookmarks." : has.logo ? "Not set: the logo is used as the icon." : "Not set: the default icon is used."}
            url={has.favicon ? brand.faviconUrl : null}
            present={has.favicon}
            surface="auto"
            square
          />
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Reset branding"
          description="Go back to the default name, logo, icon and colour."
          actions={
            <Button
              size="sm"
              variant="danger-ghost"
              loading={reset.pending}
              onClick={async () => {
                if (
                  await confirm({
                    title: "Reset branding?",
                    description: "The uploaded images are deleted, and the name and colour go back to the defaults.",
                    confirmLabel: "Reset",
                    danger: true,
                  })
                )
                  reset.run();
              }}
            >
              <RotateCcw /> Reset
            </Button>
          }
        />
      </Card>
    </>
  );
}

function ImageSlot({
  kind,
  title,
  hint,
  url,
  present,
  surface,
  square,
}: {
  kind: BrandAssetKind;
  title: string;
  hint: string;
  url: string | null;
  present: boolean;
  /** Background the image is previewed on. */
  surface: "light" | "dark" | "auto";
  square?: boolean;
}) {
  const input = React.useRef<HTMLInputElement>(null);
  const upload = useAction((file: File) => {
    const form = new FormData();
    form.set("file", file);
    return uploadBrandImage(kind, form);
  });
  const remove = useAction(() => removeBrandImage(kind));

  return (
    <div className="flex min-w-0 flex-col gap-3 rounded-xl border border-line p-4">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[13px] font-medium text-fg">{title}</span>
        {present ? <Badge tone="ok">Custom</Badge> : <Badge>Default</Badge>}
      </div>
      <div
        className={cn(
          "flex h-20 items-center justify-center rounded-lg border border-line px-4",
          surface === "light" && "bg-[#f5f5f7]",
          surface === "dark" && "bg-[#0b0b0d]",
          surface === "auto" && "bg-sunken",
        )}
      >
        {url ? (
          // Uploaded images are only drawn through <img>, so an SVG cannot run scripts.
          <img src={url} alt="" className={cn("max-w-full object-contain", square ? "size-10" : "h-8 max-w-[200px]")} draggable={false} />
        ) : (
          <span className={cn("text-xs", surface === "dark" ? "text-white/40" : "text-faint")}>Nothing uploaded</span>
        )}
      </div>
      <p className="text-xs leading-relaxed text-muted">{hint}</p>
      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={input}
          type="file"
          accept={acceptedTypes[kind].join(",") + (kind === "favicon" ? ",.ico" : "")}
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) void upload.run(file);
          }}
        />
        <Button type="button" size="sm" onClick={() => input.current?.click()} loading={upload.pending}>
          <ImageUp /> {present ? "Replace" : "Upload"}
        </Button>
        {present && (
          <Button type="button" size="sm" variant="danger-ghost" onClick={() => remove.run()} loading={remove.pending}>
            <Trash2 /> Remove
          </Button>
        )}
      </div>
    </div>
  );
}
