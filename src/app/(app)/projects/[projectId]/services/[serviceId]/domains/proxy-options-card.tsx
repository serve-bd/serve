"use client";

import * as React from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardFooter, CardHeader } from "@/components/ui/misc";
import { Field } from "@/components/ui/field";
import { Input, InputGroup, Textarea } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { SwitchRow } from "@/components/ui/switch";
import { useAction } from "@/hooks/use-action";
import { updateServiceProxy } from "@/server/actions/service-proxy";
import type { ServiceProxyConfig } from "@/server/services/proxy-config";

type Initial = Omit<ServiceProxyConfig, "basicAuth"> & { basicAuthUser: string | null; basicAuthHasBcrypt?: boolean };

type Form = {
  maxBodySize: string;
  connectTimeout: string;
  readTimeout: string;
  websockets: boolean;
  buffering: boolean;
  authOn: boolean;
  authUser: string;
  authPassword: string;
  allow: string;
  deny: string;
  headers: { name: string; value: string }[];
  securityHeaders: boolean;
  cors: string;
  wwwRedirect: "none" | "to-apex" | "to-www";
  gzip: boolean;
  cacheStatic: boolean;
  customDirectives: string;
  caddyDirectives: string;
  traefikMiddlewares: string;
};

function toForm(c: Initial | null): Form {
  return {
    maxBodySize: c?.maxBodySize ?? "",
    connectTimeout: c?.connectTimeout ? String(c.connectTimeout) : "",
    readTimeout: c?.readTimeout ? String(c.readTimeout) : "",
    websockets: c?.websockets ?? true,
    buffering: c?.buffering ?? true,
    authOn: !!c?.basicAuthUser,
    authUser: c?.basicAuthUser ?? "",
    authPassword: "",
    allow: (c?.allow ?? []).join("\n"),
    deny: (c?.deny ?? []).join("\n"),
    headers: c?.headers ?? [],
    securityHeaders: c?.securityHeaders ?? false,
    cors: (c?.corsOrigins ?? []).join("\n"),
    wwwRedirect: c?.wwwRedirect ?? "none",
    gzip: c?.gzip ?? true,
    cacheStatic: c?.cacheStatic ?? false,
    customDirectives: c?.customDirectives ?? "",
    caddyDirectives: c?.caddyDirectives ?? "",
    traefikMiddlewares: c?.traefikMiddlewares ?? "",
  };
}

const lines = (v: string) =>
  v
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
const seconds = (v: string) => (v.trim() ? Number(v.replace(/\D/g, "")) || null : null);

function Group({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-4 border-t border-line px-5 py-5 first:border-t-0">
      <div>
        <h3 className="text-[13px] font-semibold text-fg">{title}</h3>
        {description && <p className="mt-0.5 text-xs text-muted">{description}</p>}
      </div>
      {children}
    </section>
  );
}

const KIND_LABEL = { nginx: "nginx", caddy: "Caddy", traefik: "Traefik" } as const;

/** Per-service HTTP options (limits, access control, headers, performance, raw directives for the server's proxy). */
export function ProxyOptionsCard({
  serviceId,
  initial,
  isAdmin,
  isInstanceAdmin,
  hasTls,
  proxyKind = "nginx",
}: {
  serviceId: string;
  initial: Initial | null;
  isAdmin: boolean;
  isInstanceAdmin: boolean;
  hasTls: boolean;
  proxyKind?: "nginx" | "caddy" | "traefik";
}) {
  const proxyLabel = KIND_LABEL[proxyKind];
  const [form, setForm] = React.useState<Form>(() => toForm(initial));
  const [saved, setSaved] = React.useState(() => JSON.stringify(toForm(initial)));
  const [error, setError] = React.useState<string | null>(null);
  const dirty = JSON.stringify(form) !== saved;
  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm((f) => ({ ...f, [key]: value }));

  const save = useAction(
    async () => {
      setError(null);
      const res = await updateServiceProxy(serviceId, {
        maxBodySize: form.maxBodySize.trim() || null,
        connectTimeout: seconds(form.connectTimeout),
        readTimeout: seconds(form.readTimeout),
        websockets: form.websockets,
        buffering: form.buffering,
        basicAuth: { enabled: form.authOn, username: form.authUser.trim() || undefined, password: form.authPassword || undefined },
        allow: lines(form.allow),
        deny: lines(form.deny),
        headers: form.headers.filter((h) => h.name.trim()).map((h) => ({ name: h.name.trim(), value: h.value })),
        securityHeaders: form.securityHeaders,
        corsOrigins: lines(form.cors),
        wwwRedirect: form.wwwRedirect,
        gzip: form.gzip,
        cacheStatic: form.cacheStatic,
        customDirectives: form.customDirectives.trim() || null,
        caddyDirectives: form.caddyDirectives.trim() || null,
        traefikMiddlewares: form.traefikMiddlewares.trim() || null,
      });
      if (!res.ok) setError(res.error);
      return res;
    },
    {
      success: "HTTP options applied",
      onSuccess: () => {
        const next = { ...form, authPassword: "" };
        setForm(next);
        setSaved(JSON.stringify(next));
      },
    },
  );

  const disabled = !isAdmin;
  return (
    <Card>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save.run();
        }}
      >
        <CardHeader title="HTTP options" description="How the proxy handles requests for this service's domains. Defaults suit most apps." />
        <fieldset disabled={disabled} className="min-w-0">
          <Group title="Limits and timeouts" description="Raise these for large uploads, long requests or streaming.">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <Field label="Max request body" optional description="Like 10m or 1g. Server default otherwise.">
                <Input value={form.maxBodySize} onChange={(e) => set("maxBodySize", e.target.value)} placeholder="100m" className="font-mono" />
              </Field>
              <Field label="Connect timeout" optional>
                <InputGroup suffix="s">
                  <Input value={form.connectTimeout} onChange={(e) => set("connectTimeout", e.target.value)} placeholder="10" inputMode="numeric" />
                </InputGroup>
              </Field>
              <Field label="Read / send timeout" optional>
                <InputGroup suffix="s">
                  <Input value={form.readTimeout} onChange={(e) => set("readTimeout", e.target.value)} placeholder="300" inputMode="numeric" />
                </InputGroup>
              </Field>
            </div>
            <SwitchRow title="WebSockets" description="Upgrade connections for WebSocket apps." checked={form.websockets} onCheckedChange={(v) => set("websockets", v)} />
            <SwitchRow
              title="Response buffering"
              description="Turn off for server-sent events and streamed responses, so data reaches the browser at once."
              checked={form.buffering}
              onCheckedChange={(v) => set("buffering", v)}
            />
          </Group>

          <Group title="Access control" description="Protect previews, admin panels or staging sites.">
            <SwitchRow title="Password protection" description="Browsers ask for a user name and password (HTTP Basic Auth)." checked={form.authOn} onCheckedChange={(v) => set("authOn", v)} />
            {form.authOn && (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label="User name">
                  <Input value={form.authUser} onChange={(e) => set("authUser", e.target.value)} placeholder="admin" />
                </Field>
                <Field
                  label="Password"
                  error={proxyKind === "caddy" && initial?.basicAuthUser && !initial.basicAuthHasBcrypt && !form.authPassword ? "Enter the password again: Caddy needs a new hash. Until then the site answers 503." : undefined}
                  description={initial?.basicAuthUser ? "Leave empty to keep the current password." : undefined}
                >
                  <Input type="password" value={form.authPassword} onChange={(e) => set("authPassword", e.target.value)} placeholder={initial?.basicAuthUser ? "••••••••" : "At least 6 characters"} />
                </Field>
              </div>
            )}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Allow only" optional description="One IP or CIDR per line. Everyone else gets 403.">
                <Textarea value={form.allow} onChange={(e) => set("allow", e.target.value)} placeholder={"203.0.113.10\n10.0.0.0/8"} rows={3} className="min-h-20 font-mono text-[12.5px]" />
              </Field>
              <Field
                label="Block"
                optional
                description={proxyKind === "traefik" ? "One IP or CIDR per line. Traefik has no block list: blocked visitors get the 404 page, and visitors through a Cloudflare Tunnel cannot be blocked here." : "One IP or CIDR per line."}
              >
                <Textarea value={form.deny} onChange={(e) => set("deny", e.target.value)} placeholder="198.51.100.0/24" rows={3} className="min-h-20 font-mono text-[12.5px]" />
              </Field>
            </div>
          </Group>

          <Group title="Headers" description="Response headers added to every request.">
            <SwitchRow
              title="Security headers"
              description={`Adds X-Content-Type-Options, Referrer-Policy and X-Frame-Options${hasTls ? ", and HSTS with subdomains" : ""}.`}
              checked={form.securityHeaders}
              onCheckedChange={(v) => set("securityHeaders", v)}
            />
            <Field label="CORS allowed origins" optional description="* or one origin per line, like https://app.example.com. Preflight requests are answered by the proxy.">
              <Textarea value={form.cors} onChange={(e) => set("cors", e.target.value)} placeholder="https://app.example.com" rows={2} className="min-h-16 font-mono text-[12.5px]" />
            </Field>
            <div className="flex flex-col gap-2">
              <span className="text-[13px] font-medium text-fg-2">Custom headers</span>
              {form.headers.map((h, i) => (
                <div key={i} className="grid grid-cols-[minmax(0,1fr)_32px] gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)_32px]">
                  <Input
                    value={h.name}
                    onChange={(e) => set("headers", form.headers.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
                    placeholder="X-Robots-Tag"
                    aria-label="Header name"
                    className="h-8 font-mono text-[12.5px]"
                  />
                  <Button variant="ghost" size="icon" className="sm:order-3" onClick={() => set("headers", form.headers.filter((_, j) => j !== i))} aria-label="Remove header">
                    <Trash2 />
                  </Button>
                  <Input
                    value={h.value}
                    onChange={(e) => set("headers", form.headers.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))}
                    placeholder="noindex"
                    aria-label="Header value"
                    className="col-span-2 h-8 font-mono text-[12.5px] sm:order-2 sm:col-span-1"
                  />
                </div>
              ))}
              <Button size="sm" variant="ghost" className="w-fit" onClick={() => set("headers", [...form.headers, { name: "", value: "" }])}>
                <Plus /> Add header
              </Button>
            </div>
          </Group>

          <Group title="Performance and routing">
            <SwitchRow title="Compression" description="Gzip text responses." checked={form.gzip} onCheckedChange={(v) => set("gzip", v)} />
            <SwitchRow title="Cache static files" description="Browsers keep CSS, JS, images and fonts for 7 days." checked={form.cacheStatic} onCheckedChange={(v) => set("cacheStatic", v)} />
            <Field label="www redirect" description="Works when both example.com and www.example.com are added as domains here.">
              <Select
                value={form.wwwRedirect}
                onValueChange={(v) => set("wwwRedirect", v as Form["wwwRedirect"])}
                options={[
                  { value: "none", label: "No redirect" },
                  { value: "to-apex", label: "www.example.com → example.com" },
                  { value: "to-www", label: "example.com → www.example.com" },
                ]}
                className="sm:max-w-sm"
              />
            </Field>
          </Group>

          <Group
            title="Advanced"
            description={
              proxyKind === "nginx"
                ? "Raw nginx directives inside this service's location block. Tested before they apply."
                : proxyKind === "caddy"
                  ? "Raw Caddyfile directives inside this service's route, before the request reaches the app. Tested before they apply."
                  : "Extra Traefik middlewares as YAML (name: definition). They run after Serve's own. Checked against Traefik before they apply."
            }
          >
            <Textarea
              value={proxyKind === "nginx" ? form.customDirectives : proxyKind === "caddy" ? form.caddyDirectives : form.traefikMiddlewares}
              onChange={(e) => set(proxyKind === "nginx" ? "customDirectives" : proxyKind === "caddy" ? "caddyDirectives" : "traefikMiddlewares", e.target.value)}
              disabled={!isInstanceAdmin}
              placeholder={
                !isInstanceAdmin
                  ? "Only Root organization admins can add custom directives."
                  : proxyKind === "nginx"
                    ? "# Example\nproxy_set_header X-Custom value;"
                    : proxyKind === "caddy"
                      ? "# Example\nheader_up X-Custom value"
                      : "ratelimit:\n  rateLimit:\n    average: 100\n    burst: 50"
              }
              rows={5}
              spellCheck={false}
              className="font-mono text-[12.5px]"
            />
            <p className="text-xs text-muted">Directives for the other proxies are kept and used if this server switches proxy.</p>
          </Group>
        </fieldset>
        {error && <p className="border-t border-line bg-bad-soft/50 px-5 py-3 font-mono text-[12px] leading-relaxed break-words text-bad">{error}</p>}
        <CardFooter>
          <span className="truncate text-xs text-muted">{dirty ? "Unsaved changes" : `${proxyLabel} checks the configuration before applying it`}</span>
          <div className="flex flex-none gap-2">
            {dirty && (
              <Button type="button" variant="ghost" size="sm" onClick={() => setForm(JSON.parse(saved))}>
                Discard
              </Button>
            )}
            <Button type="submit" size="sm" variant="primary" disabled={!dirty || disabled} loading={save.pending}>
              Apply
            </Button>
          </div>
        </CardFooter>
      </form>
    </Card>
  );
}
